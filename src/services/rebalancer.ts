import type { Logger } from "pino";

import type { AppConfig } from "../config.js";
import {
  TransactionTimeoutError,
  type BotRuntimeState,
  type PendingRebalance,
  type PositionLedgerCloseInput,
  type PositionLedgerMarkInput,
  type PositionLedgerOpenInput,
  type RebalancePhase,
  type WalletBalances
} from "../domain.js";
import { RpcAccountReader } from "../infra/rpcAccountReader.js";
import { isRecoverableRpcError } from "../infra/rpcFailover.js";
import { TransactionInspector } from "../infra/transactionInspector.js";
import {
  classifyCloseTimeout,
  classifyOpenTimeout,
  classifySwapTimeout,
  shouldRecoverPausedTimeout
} from "./recovery.js";
import {
  computeBinRange,
  computeCenteredBinRange,
  computeTargetValueWeights,
  evaluateDriftTrigger,
  evaluateBinDriftTrigger,
  evaluateProactiveDriftTrigger,
  binIdToPrice,
  fromBaseUnits,
  toBaseUnits
} from "../strategy/bins.js";
import { InsufficientAllocationError, MeteoraClient, type CompoundFeesResult } from "../clients/meteoraClient.js";

export type RunMode = "run" | "dry-run" | "rebalance-now";

interface RuntimeStateStore {
  load(): Promise<BotRuntimeState>;
  save(state: BotRuntimeState): Promise<void>;
}

interface RebalancerOptions {
  botId?: string;
  botName?: string;
  poolAddress?: string;
  tokenAMint?: string;
  tokenBMint?: string;
  tokenADecimals?: number;
  tokenBDecimals?: number;
  tokenASymbol?: string;
  tokenBSymbol?: string;
  binStep?: number;
  minPrice?: number;
  maxPrice?: number;
  strategy?: import("../config.js").StrategyType;
  allocationUsdc?: number;
  runExclusive?: <T>(reason: "trigger" | "manual" | "recovery", task: () => Promise<T>) => Promise<T>;
  listClaimedPositionAddresses?: () => Promise<string[]>;
  resolveAllocationQuoteBudget?: (currentPrice: number) => Promise<number | null>;
  onPositionOpened?: (input: PositionLedgerOpenInput) => Promise<void>;
  onPositionClosed?: (input: PositionLedgerCloseInput) => Promise<void>;
  onPositionMarked?: (input: PositionLedgerMarkInput) => Promise<void>;
  onRangeUpdated?: (newMin: number, newMax: number) => Promise<void>;
  autoCompound?: boolean;
  compoundMinValueQuote?: number;
  driftThresholdPct?: number;
  rangeBins?: number | null;
  trendShiftBins?: number;
}

class AllocationQuoteBudgetUnavailableError extends Error {
  constructor() {
    super("Allocation quote budget is unavailable for this pool");
    this.name = "AllocationQuoteBudgetUnavailableError";
  }
}

export class RebalancerService {
  private readonly accountReader: RpcAccountReader;
  private readonly transactionInspector: TransactionInspector;
  private static readonly POST_CLOSE_BALANCE_WAIT_MS = 20_000;
  private static readonly POST_CLOSE_BALANCE_POLL_MS = 1_500;
  private static readonly PNL_MARK_INTERVAL_MS = 60_000;
  private static readonly MAX_TIMEOUT_RETRIES = 1;
  private static readonly MAX_STRICT_PREOPEN_SWAPS = 4;
  private static readonly MAX_OPEN_FAILURE_PREOPEN_SWAPS = 8;
  private static readonly CLOSE_RETRY_BACKOFF_MS = 5_000;
  private static readonly MAX_CLOSE_RETRY_BACKOFF_MS = 60_000;
  private static readonly OPEN_RETRY_BACKOFF_MS = 5_000;
  private static readonly MAX_OPEN_RETRY_BACKOFF_MS = 60_000;
  private static readonly RPC_RETRY_BACKOFF_MS = 5_000;
  private static readonly MAX_RPC_RETRY_BACKOFF_MS = 60_000;
  private static readonly MAX_RECOVERABLE_RPC_RETRIES = 12;
  private static readonly TIMEOUT_TEXT = "Transaction confirmation timeout";
  private static readonly BLOCK_HEIGHT_TEXT = "block height exceeded";

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly stateStore: RuntimeStateStore,
    private readonly meteoraClient: MeteoraClient,
    private readonly options: RebalancerOptions = {}
  ) {
    this.accountReader = new RpcAccountReader(config.solanaRpcUrls);
    this.transactionInspector = new TransactionInspector(config.solanaRpcUrls);
  }

  async run(mode: RunMode): Promise<void> {
    if (mode === "run") {
      for (;;) {
        await this.runCycle(mode);
        await this.sleep(this.config.POLL_SECONDS * 1000);
      }
    }

    await this.runCycle(mode);
  }

  async runCycle(mode: RunMode): Promise<void> {
    const state = await this.stateStore.load();
    if (state.pendingRebalance) {
      this.normalizePendingRebalance(state.pendingRebalance);
    }
    state.lastCycleAt = new Date().toISOString();
    const wasTriggered = state.driftStatus === "triggered";

    if (!state.pendingRebalance && state.inFlightRebalance) {
      state.inFlightRebalance = false;
      await this.stateStore.save(state);
    }

    if (!state.pendingRebalance && state.paused && this.isTimeoutMessage(state.pauseReason)) {
      await this.seedLegacyTimeoutRecovery(state);
    }

    if (state.pendingRebalance) {
      if (state.paused && !this.shouldRecoverPausedPendingRebalance(state)) {
        this.logger.warn({ pauseReason: state.pauseReason }, "bot is paused");
        return;
      }

      await this.runExclusive("recovery", () => this.reconcilePendingRebalance(state));
      return;
    }

    if (state.paused) {
      // Auto-unpause if the pause reason is a transient timeout/expiry error
      // that couldn't be seeded into a pending rebalance recovery
      if (this.isTimeoutMessage(state.pauseReason)) {
        this.logger.info(
          { pauseReason: state.pauseReason },
          "auto-unpausing after transient timeout; will re-evaluate drift"
        );
        state.paused = false;
        state.pauseReason = null;
        await this.stateStore.save(state);
      } else {
        this.logger.warn({ pauseReason: state.pauseReason }, "bot is paused");
        return;
      }
    }

    const poolAddress = this.options.poolAddress;
    if (!poolAddress) {
      this.logger.error("no pool address configured");
      return;
    }

    const pool = await this.meteoraClient.fetchPoolSnapshot(poolAddress);
    state.lastObservedPrice = pool.currentPrice;

    if (state.activePositionAddress) {
      const livePosition = await this.meteoraClient.findManagedPosition(poolAddress, state.activePositionAddress);
      if (!livePosition) {
        this.logger.warn(
          { positionAddress: state.activePositionAddress },
          "tracked position missing on-chain; clearing stale position state"
        );
        state.activePositionAddress = null;
        state.activeLowerBinId = null;
        state.activeUpperBinId = null;
        state.lastPnlMarkAt = null;
        state.latestAction = "tracked position missing on-chain";
        await this.stateStore.save(state);
        return;
      }
    }

    const minPrice = this.options.minPrice ?? 0;
    const maxPrice = this.options.maxPrice ?? Infinity;
    const drift = evaluateDriftTrigger(pool.currentPrice, minPrice, maxPrice);

    // Also trigger if current price has left the actual on-chain LP range (price check)
    const isOutOfActualRange =
      (state.positionLowerPrice !== null && pool.currentPrice < state.positionLowerPrice) ||
      (state.positionUpperPrice !== null && pool.currentPrice > state.positionUpperPrice);

    // Primary bin-level check: compare pool's active bin against position bin range.
    // This is the most reliable DLMM out-of-range detection (integer comparison, no float issues).
    const binDrift =
      state.activeLowerBinId !== null && state.activeUpperBinId !== null
        ? evaluateBinDriftTrigger(pool.activeBinId, state.activeLowerBinId, state.activeUpperBinId)
        : null;
    const isOutOfBinRange = binDrift?.shouldRebalance ?? false;

    // Proactive drift: trigger early before price fully exits the range
    const driftThresholdPct = this.options.driftThresholdPct ?? 0;
    const proactiveDrift =
      driftThresholdPct > 0 && state.positionLowerPrice !== null && state.positionUpperPrice !== null
        ? evaluateProactiveDriftTrigger(pool.currentPrice, state.positionLowerPrice, state.positionUpperPrice, driftThresholdPct)
        : null;
    const isProactivelyTriggered = proactiveDrift?.shouldRebalance ?? false;

    const shouldRebalance = mode === "rebalance-now" ? true : drift.shouldRebalance || wasTriggered || isOutOfActualRange || isOutOfBinRange || isProactivelyTriggered;
    const outOfRange = isOutOfActualRange || isOutOfBinRange;
    const resolvedDirection = outOfRange && !drift.direction
      ? (binDrift?.direction ?? (pool.currentPrice < (state.lastCenterPrice ?? pool.currentPrice) ? "below" : "above"))
      : (isProactivelyTriggered && !drift.direction ? proactiveDrift!.direction : drift.direction);
    state.driftDirection = shouldRebalance
      ? (resolvedDirection ?? state.driftDirection)
      : drift.direction;
    state.driftStatus = shouldRebalance ? "triggered" : "waiting";

    this.logger.info(
      {
        mode,
        anchorPrice: state.lastCenterPrice ?? pool.currentPrice,
        currentPrice: pool.currentPrice,
        activeBinId: pool.activeBinId,
        minPrice,
        maxPrice,
        positionLowerPrice: state.positionLowerPrice,
        positionUpperPrice: state.positionUpperPrice,
        positionLowerBinId: state.activeLowerBinId,
        positionUpperBinId: state.activeUpperBinId,
        isOutOfActualRange,
        isOutOfBinRange,
        isProactivelyTriggered,
        driftDirection: state.driftDirection,
        driftStatus: state.driftStatus,
        shouldRebalance
      },
      "cycle evaluated"
    );

    // PNL mark for open positions
    if (
      state.activePositionAddress &&
      this.options.onPositionMarked &&
      (!state.lastPnlMarkAt || Date.now() - Date.parse(state.lastPnlMarkAt) >= RebalancerService.PNL_MARK_INTERVAL_MS)
    ) {
      try {
        const markResult = await this.meteoraClient.closePosition(poolAddress, state.activePositionAddress, false);
        const tokenADecimals = this.options.tokenADecimals ?? 9;
        const tokenBDecimals = this.options.tokenBDecimals ?? 6;
        const grossTokenA = markResult.withdrawnTokenA + markResult.feesTokenA;
        const grossTokenB = markResult.withdrawnTokenB + markResult.feesTokenB;
        const grossValueQuote =
          fromBaseUnits(grossTokenA, tokenADecimals) * pool.currentPrice +
          fromBaseUnits(grossTokenB, tokenBDecimals);
        const feesEarnedQuote =
          fromBaseUnits(markResult.feesTokenA, tokenADecimals) * pool.currentPrice +
          fromBaseUnits(markResult.feesTokenB, tokenBDecimals);

        await this.options.onPositionMarked({
          botId: this.options.botId ?? "legacy",
          positionAddress: state.activePositionAddress,
          markedAt: state.lastCycleAt!,
          centerPrice: pool.currentPrice,
          grossValueQuote,
          feesEarnedQuote,
          grossTokenA: grossTokenA.toString(),
          grossTokenB: grossTokenB.toString()
        });
        state.lastPnlMarkAt = state.lastCycleAt;
      } catch (error) {
        this.logger.warn(
          { positionAddress: state.activePositionAddress, error: (error as Error).message },
          "pnl mark refresh failed"
        );
      }
    }

    // Auto-compound: claim fees and deposit them back into the position
    if (
      state.activePositionAddress &&
      this.options.autoCompound &&
      !shouldRebalance
    ) {
      try {
        const livePos = await this.meteoraClient.findManagedPosition(poolAddress, state.activePositionAddress);
        if (livePos) {
          const tokenADecimals = this.options.tokenADecimals ?? 9;
          const tokenBDecimals = this.options.tokenBDecimals ?? 6;
          const feeValueQuote =
            fromBaseUnits(livePos.feeTokenA, tokenADecimals) * pool.currentPrice +
            fromBaseUnits(livePos.feeTokenB, tokenBDecimals);
          const minValue = this.options.compoundMinValueQuote ?? 0;

          if (feeValueQuote > minValue && feeValueQuote > 0) {
            this.logger.info(
              { feeValueQuote, minValue, positionAddress: state.activePositionAddress },
              "auto-compound threshold met, compounding fees"
            );
            await this.runExclusive("manual", () => this.compoundFees());
          }
        }
      } catch (error) {
        this.logger.warn(
          { positionAddress: state.activePositionAddress, error: (error as Error).message },
          "auto-compound failed"
        );
      }
    }

    if (!state.activePositionAddress) {
      state.latestAction = "bootstrapping initial LP position";
      await this.stateStore.save(state);
      await this.runRebalanceWithRecoverableTriggerRetry(
        state,
        mode,
        pool.currentPrice,
        "bootstrapping initial LP position"
      );
      return;
    }

    if (shouldRebalance) {
      await this.runRebalanceWithRecoverableTriggerRetry(
        state,
        mode,
        pool.currentPrice,
        mode === "rebalance-now" ? "manual rebalance retry after rpc error" : "trigger latched; retrying after rpc error"
      );
      return;
    }

    state.latestAction = "waiting for drift trigger";
    await this.stateStore.save(state);
  }

  async closePositionOnly(): Promise<{ positionAddress: string; txId: string | null } | null> {
    const state = await this.stateStore.load();
    const poolAddress = this.options.poolAddress;
    if (!poolAddress) return null;

    if (!state.activePositionAddress) {
      this.logger.info("close-position-only: no active position to close");
      return null;
    }

    const livePosition = await this.meteoraClient.findManagedPosition(poolAddress, state.activePositionAddress);
    if (!livePosition) {
      this.logger.info({ positionAddress: state.activePositionAddress }, "close-position-only: position not found on-chain");
      state.activePositionAddress = null;
      state.activeLowerBinId = null;
      state.activeUpperBinId = null;
      await this.stateStore.save(state);
      return null;
    }

    const pool = await this.meteoraClient.fetchPoolSnapshot(poolAddress);
    const positionAddress = state.activePositionAddress;
    const closeResult = await this.meteoraClient.closePosition(poolAddress, positionAddress, true);
    const closeTxId = closeResult.txIds[0] ?? null;
    const closeSummary = await this.inspectTransaction(closeTxId);

    const tokenADecimals = this.options.tokenADecimals ?? 9;
    const tokenBDecimals = this.options.tokenBDecimals ?? 6;
    const grossTokenA = closeResult.withdrawnTokenA + closeResult.feesTokenA;
    const grossTokenB = closeResult.withdrawnTokenB + closeResult.feesTokenB;
    const exitGrossQuote =
      fromBaseUnits(grossTokenA, tokenADecimals) * pool.currentPrice +
      fromBaseUnits(grossTokenB, tokenBDecimals);
    const feesEarnedQuote =
      fromBaseUnits(closeResult.feesTokenA, tokenADecimals) * pool.currentPrice +
      fromBaseUnits(closeResult.feesTokenB, tokenBDecimals);

    this.logger.info(
      { closeTxId, positionAddress, execute: true, manual: true },
      "position close evaluated"
    );

    if (this.options.onPositionClosed) {
      try {
        await this.options.onPositionClosed({
          botId: this.options.botId ?? "legacy",
          positionAddress,
          closedAt: new Date().toISOString(),
          centerPrice: pool.currentPrice,
          exitGrossQuote,
          feesEarnedQuote,
          exitTokenA: grossTokenA.toString(),
          exitTokenB: grossTokenB.toString(),
          closeTxId,
          closeTxFeeLamports: closeSummary?.feeLamports ?? 0
        });
      } catch (error) {
        this.logger.warn({ error: (error as Error).message }, "manual close pnl update failed");
      }
    }

    state.activePositionAddress = null;
    state.activeLowerBinId = null;
    state.activeUpperBinId = null;
    state.driftStatus = null;
    state.driftDirection = null;
    state.positionLowerPrice = null;
    state.positionUpperPrice = null;
    state.latestAction = "position manually closed";
    await this.stateStore.save(state);

    return { positionAddress, txId: closeTxId };
  }

  async compoundFees(): Promise<CompoundFeesResult | null> {
    const state = await this.stateStore.load();
    const poolAddress = this.options.poolAddress;
    if (!poolAddress) return null;

    if (!state.activePositionAddress) {
      this.logger.info("compound-fees: no active position");
      return null;
    }

    if (state.activeLowerBinId == null || state.activeUpperBinId == null) {
      this.logger.warn("compound-fees: missing bin range in state");
      return null;
    }

    const livePosition = await this.meteoraClient.findManagedPosition(poolAddress, state.activePositionAddress);
    if (!livePosition) {
      this.logger.warn({ positionAddress: state.activePositionAddress }, "compound-fees: position not found on-chain");
      return null;
    }

    const result = await this.meteoraClient.claimAndCompoundFees({
      poolAddress,
      positionAddress: state.activePositionAddress,
      lowerBinId: state.activeLowerBinId,
      upperBinId: state.activeUpperBinId,
      strategy: this.options.strategy ?? "Spot"
    });

    if (result.feesTokenA > 0n || result.feesTokenB > 0n) {
      state.latestAction = "fees compounded into position";
      await this.stateStore.save(state);
    }

    return result;
  }

  private async executeRebalance(mode: RunMode, state: BotRuntimeState, currentPrice: number): Promise<void> {
    if (state.pendingRebalance) {
      await this.reconcilePendingRebalance(state);
      return;
    }

    if (state.inFlightRebalance) {
      this.logger.warn("rebalance skipped because one is already in flight");
      return;
    }

    if (mode === "dry-run") {
      await this.executeDryRunRebalance(state, currentPrice);
      return;
    }

    const poolAddress = this.options.poolAddress!;
    const existingPosition = state.activePositionAddress
      ? await this.meteoraClient.findManagedPosition(poolAddress, state.activePositionAddress)
      : null;

    state.pendingRebalance = {
      phase: existingPosition ? "closing" : "swapping",
      startedAt: new Date().toISOString(),
      nextRetryAt: null,
      anchorPrice: state.lastCenterPrice ?? currentPrice,
      targetCenterPrice: currentPrice,
      previousPositionAddress: existingPosition?.positionAddress ?? null,
      plannedPositionAddress: null,
      lastKnownCloseTxId: null,
      lastKnownSwapTxId: null,
      lastKnownOpenTxId: null,
      recoveryReason: null,
      retryCount: 0,
      openFailureCount: 0,
      entryCapitalQuote: null,
      entryTokenA: null,
      entryTokenB: null,
      cumulativeSwapFeeQuote: 0,
      cumulativeTxFeeLamports: 0
    };
    state.inFlightRebalance = true;
    state.paused = false;
    state.pauseReason = null;
    state.latestAction = "rebalance started";
    await this.stateStore.save(state);

    await this.reconcilePendingRebalance(state);
  }

  private async runRebalanceWithRecoverableTriggerRetry(
    state: BotRuntimeState,
    mode: RunMode,
    currentPrice: number,
    latestActionOnRecoverableError: string
  ) {
    try {
      await this.runExclusive(mode === "rebalance-now" ? "manual" : "trigger", () =>
        this.executeRebalance(mode, state, currentPrice)
      );
    } catch (error) {
      if (!isRecoverableRpcError(error)) {
        throw error;
      }

      state.driftStatus = "triggered";
      state.latestAction = latestActionOnRecoverableError;
      await this.stateStore.save(state);

      this.logger.warn(
        { error: (error as Error).message, currentPrice, mode },
        "recoverable rpc error while starting rebalance; trigger retained"
      );
    }
  }

  private async executeDryRunRebalance(state: BotRuntimeState, currentPrice: number) {
    const poolAddress = this.options.poolAddress!;
    const binStep = this.options.binStep ?? 1;
    const strategy = this.options.strategy ?? "Spot";
    const tokenAMint = this.options.tokenAMint ?? "";
    const tokenBMint = this.options.tokenBMint ?? "";

    const existingPosition = state.activePositionAddress
      ? await this.meteoraClient.findManagedPosition(poolAddress, state.activePositionAddress)
      : null;
    let balances = await this.meteoraClient.getWalletBalances(tokenAMint, tokenBMint);

    if (existingPosition) {
      const closeResult = await this.meteoraClient.closePosition(poolAddress, existingPosition.positionAddress, false);
      this.logger.info(
        { positionAddress: existingPosition.positionAddress, execute: false },
        "position close evaluated"
      );

      balances = {
        tokenA: balances.tokenA + closeResult.withdrawnTokenA,
        tokenB: balances.tokenB + closeResult.withdrawnTokenB
      };
    }

    balances = await this.capBalancesToAllocation(currentPrice, balances);

    // Compute swap needed
    const { lowerBinId, upperBinId } = this.computeTargetBinRange(currentPrice, null);
    const lowerPrice = binIdToPrice(lowerBinId, binStep, this.decimalAdjust);
    const upperPrice = binIdToPrice(upperBinId, binStep, this.decimalAdjust);
    const weights = computeTargetValueWeights(lowerPrice, currentPrice, upperPrice, strategy);

    this.logger.info(
      {
        execute: false,
        lowerBinId,
        upperBinId,
        lowerPrice,
        upperPrice,
        targetWeights: weights,
        tokenA: balances.tokenA.toString(),
        tokenB: balances.tokenB.toString()
      },
      "dry-run rebalance complete"
    );

    state.latestAction = "dry-run rebalance complete";
    await this.stateStore.save(state);
  }

  private async seedLegacyTimeoutRecovery(state: BotRuntimeState) {
    const targetCenterPrice = state.lastObservedPrice ?? state.lastCenterPrice;
    if (!targetCenterPrice) {
      return;
    }

    const poolAddress = this.options.poolAddress;
    if (!poolAddress) return;

    const livePosition = state.activePositionAddress
      ? await this.meteoraClient.findManagedPosition(poolAddress, state.activePositionAddress)
      : null;
    let phase: RebalancePhase = "closing";
    let plannedPositionAddress: string | null = null;

    if (!livePosition) {
      phase = "swapping";
    } else if (state.activePositionAddress && livePosition.positionAddress !== state.activePositionAddress) {
      phase = "opening";
      plannedPositionAddress = livePosition.positionAddress;
    }

    state.pendingRebalance = {
      phase,
      startedAt: new Date().toISOString(),
      nextRetryAt: null,
      anchorPrice: state.lastCenterPrice ?? targetCenterPrice,
      targetCenterPrice,
      previousPositionAddress: state.activePositionAddress,
      plannedPositionAddress,
      lastKnownCloseTxId: null,
      lastKnownSwapTxId: null,
      lastKnownOpenTxId: null,
      recoveryReason: state.pauseReason,
      retryCount: 0,
      openFailureCount: 0,
      entryCapitalQuote: null,
      entryTokenA: null,
      entryTokenB: null,
      cumulativeSwapFeeQuote: 0,
      cumulativeTxFeeLamports: 0
    };
    state.inFlightRebalance = true;
    state.latestAction = `reconciling timed-out ${phase} phase`;
    await this.stateStore.save(state);

    this.logger.warn(
      { phase, previousPositionAddress: state.activePositionAddress, targetCenterPrice },
      "legacy timeout state migrated into pending rebalance"
    );
  }

  private async reconcilePendingRebalance(state: BotRuntimeState) {
    if (!state.pendingRebalance) {
      return;
    }

    if (state.paused) {
      state.paused = false;
      state.pauseReason = null;
      state.latestAction = `reconciling timeout (${state.pendingRebalance.phase})`;
      await this.stateStore.save(state);
    }

    state.inFlightRebalance = true;

    while (state.pendingRebalance && !state.paused) {
      if (state.pendingRebalance.nextRetryAt) {
        const retryAtMs = Date.parse(state.pendingRebalance.nextRetryAt);
        if (Number.isFinite(retryAtMs) && retryAtMs > Date.now()) {
          return;
        }

        state.pendingRebalance.nextRetryAt = null;
        await this.stateStore.save(state);
      }

      switch (state.pendingRebalance.phase) {
        case "closing":
          await this.executeClosePhase(state);
          break;
        case "swapping":
          await this.executeSwapPhase(state);
          break;
        case "opening":
          await this.executeOpenPhase(state);
          break;
      }
    }
  }

  // ── Close Phase ──────────────────────────────────────────────

  private async executeClosePhase(state: BotRuntimeState) {
    const pending = state.pendingRebalance;
    if (!pending) return;

    const poolAddress = this.options.poolAddress!;

    if (!pending.previousPositionAddress) {
      await this.advancePendingPhase(state, "swapping", "no position to close");
      return;
    }

    const livePosition = await this.meteoraClient.findManagedPosition(poolAddress, pending.previousPositionAddress);
    if (!livePosition) {
      await this.advancePendingPhase(state, "swapping", "position already closed on-chain");
      return;
    }

    try {
      const closeResult = await this.meteoraClient.closePosition(poolAddress, pending.previousPositionAddress, true);
      pending.lastKnownCloseTxId = closeResult.txIds[0] ?? null;
      const closeSummary = await this.inspectTransaction(pending.lastKnownCloseTxId);

      const tokenADecimals = this.options.tokenADecimals ?? 9;
      const tokenBDecimals = this.options.tokenBDecimals ?? 6;
      const grossTokenA = closeResult.withdrawnTokenA + closeResult.feesTokenA;
      const grossTokenB = closeResult.withdrawnTokenB + closeResult.feesTokenB;
      const exitGrossQuote =
        fromBaseUnits(grossTokenA, tokenADecimals) * pending.targetCenterPrice +
        fromBaseUnits(grossTokenB, tokenBDecimals);
      const feesEarnedQuote =
        fromBaseUnits(closeResult.feesTokenA, tokenADecimals) * pending.targetCenterPrice +
        fromBaseUnits(closeResult.feesTokenB, tokenBDecimals);

      this.logger.info(
        {
          closeTxId: pending.lastKnownCloseTxId,
          positionAddress: pending.previousPositionAddress,
          execute: true
        },
        "position close evaluated"
      );

      if (this.options.onPositionClosed) {
        try {
          await this.options.onPositionClosed({
            botId: this.options.botId ?? "legacy",
            positionAddress: pending.previousPositionAddress,
            closedAt: new Date().toISOString(),
            centerPrice: pending.targetCenterPrice,
            exitGrossQuote,
            feesEarnedQuote,
            exitTokenA: grossTokenA.toString(),
            exitTokenB: grossTokenB.toString(),
            closeTxId: pending.lastKnownCloseTxId,
            closeTxFeeLamports: closeSummary?.feeLamports ?? 0
          });
        } catch (error) {
          this.logger.warn({ error: (error as Error).message }, "position close pnl update failed");
        }
      }

      await this.advancePendingPhase(state, "swapping", "position close confirmed");
    } catch (error) {
      if (await this.handleCloseTimeout(state, error)) return;
      if (await this.handleMissingClosePosition(state, error)) return;
      if (await this.handleRecoverableRpcFailure(state, error)) return;
      if (await this.handleRetryableCloseFailure(state, error)) return;
      await this.pauseAfterFailure(state, error);
    }
  }

  // ── Swap Phase ───────────────────────────────────────────────

  private async executeSwapPhase(state: BotRuntimeState) {
    const pending = state.pendingRebalance;
    if (!pending) return;

    // Refresh target center price to current market price so the position
    // is opened at the right range (avoids stale price after pauses/retries)
    const poolAddress = this.options.poolAddress!;
    const freshPool = await this.meteoraClient.fetchPoolSnapshot(poolAddress);
    pending.targetCenterPrice = freshPool.currentPrice;

    const tokenAMint = this.options.tokenAMint ?? "";
    const tokenBMint = this.options.tokenBMint ?? "";
    const tokenADecimals = this.options.tokenADecimals ?? 9;
    const tokenBDecimals = this.options.tokenBDecimals ?? 6;
    const binStep = this.options.binStep ?? 1;
    const strategy = this.options.strategy ?? "Spot";
    const owner = this.meteoraClient.getOwnerAddress();

    let balances = pending.previousPositionAddress
      ? await this.waitForPostCloseBalances(owner, tokenAMint, tokenBMint)
      : await this.accountReader.getWalletBalances(owner, tokenAMint, tokenBMint);
    balances = await this.capBalancesToAllocation(pending.targetCenterPrice, balances);

    // Reserve SOL for position account rent and transaction fees
    const SWAP_RENT_RESERVE = 100_000_000n;
    if (tokenAMint === "So11111111111111111111111111111111111111112" && balances.tokenA > SWAP_RENT_RESERVE) {
      balances = { ...balances, tokenA: balances.tokenA - SWAP_RENT_RESERVE };
    } else if (tokenBMint === "So11111111111111111111111111111111111111112" && balances.tokenB > SWAP_RENT_RESERVE) {
      balances = { ...balances, tokenB: balances.tokenB - SWAP_RENT_RESERVE };
    }

    if (pending.entryCapitalQuote == null) {
      pending.entryCapitalQuote = this.quoteValue(pending.targetCenterPrice, balances.tokenA, balances.tokenB, tokenADecimals, tokenBDecimals);
      pending.entryTokenA = balances.tokenA.toString();
      pending.entryTokenB = balances.tokenB.toString();
    }

    try {
      const { lowerBinId, upperBinId } = this.computeTargetBinRange(pending.targetCenterPrice, state.driftDirection);
      const lowerPrice = binIdToPrice(lowerBinId, binStep, this.decimalAdjust);
      const upperPrice = binIdToPrice(upperBinId, binStep, this.decimalAdjust);
      const weights = computeTargetValueWeights(lowerPrice, pending.targetCenterPrice, upperPrice, strategy);

      const totalValueQuote = this.quoteValue(
        pending.targetCenterPrice,
        balances.tokenA,
        balances.tokenB,
        tokenADecimals,
        tokenBDecimals
      );
      const currentTokenAValue = fromBaseUnits(balances.tokenA, tokenADecimals) * pending.targetCenterPrice;
      const currentTokenAWeight = totalValueQuote > 0 ? currentTokenAValue / totalValueQuote : 0;
      const imbalance = Math.abs(currentTokenAWeight - weights.tokenA);

      // Only swap if the imbalance exceeds tolerance
      const toleranceBps = this.config.OPEN_BALANCE_TOLERANCE_BPS;
      if (imbalance > toleranceBps / 10_000) {
        const targetTokenAValue = totalValueQuote * weights.tokenA;
        const excessTokenAValue = currentTokenAValue - targetTokenAValue;

        if (excessTokenAValue > 0) {
          // Swap token A -> token B
          const swapAmountA = toBaseUnits(excessTokenAValue / pending.targetCenterPrice, tokenADecimals);
          if (swapAmountA > 0n) {
            const swapResult = await this.meteoraClient.getJupiterClient().swap({
              inputMint: tokenAMint,
              outputMint: tokenBMint,
              amount: swapAmountA.toString(),
              swapMode: "ExactIn",
              slippageBps: this.config.MAX_SLIPPAGE_BPS,
              execute: true
            });
            pending.lastKnownSwapTxId = swapResult.txId;
            const swapSummary = await this.inspectTransaction(swapResult.txId);
            pending.cumulativeTxFeeLamports += swapSummary?.feeLamports ?? 0;

            this.logger.info(
              {
                execute: true,
                direction: "A->B",
                inputAmount: swapAmountA.toString(),
                swapTxId: swapResult.txId
              },
              "swap plan evaluated"
            );
          }
        } else {
          // Swap token B -> token A
          const swapAmountB = toBaseUnits(Math.abs(excessTokenAValue), tokenBDecimals);
          if (swapAmountB > 0n) {
            const swapResult = await this.meteoraClient.getJupiterClient().swap({
              inputMint: tokenBMint,
              outputMint: tokenAMint,
              amount: swapAmountB.toString(),
              swapMode: "ExactIn",
              slippageBps: this.config.MAX_SLIPPAGE_BPS,
              execute: true
            });
            pending.lastKnownSwapTxId = swapResult.txId;
            const swapSummary = await this.inspectTransaction(swapResult.txId);
            pending.cumulativeTxFeeLamports += swapSummary?.feeLamports ?? 0;

            this.logger.info(
              {
                execute: true,
                direction: "B->A",
                inputAmount: swapAmountB.toString(),
                swapTxId: swapResult.txId
              },
              "swap plan evaluated"
            );
          }
        }
      } else {
        this.logger.info({ imbalance, toleranceBps }, "swap skipped; within tolerance");
      }

      await this.advancePendingPhase(state, "opening", "swap phase complete");
    } catch (error) {
      this.logger.error(
        { error: (error as Error).message, phase: "swapping", targetCenterPrice: pending.targetCenterPrice },
        "swap phase failed"
      );

      if (await this.handleSwapTimeout(state, error)) return;
      if (await this.handleRecoverableRpcFailure(state, error)) return;
      if (await this.handleRetryableSwapFailure(state, error)) return;
      await this.pauseAfterFailure(state, error);
    }
  }

  // ── Open Phase ───────────────────────────────────────────────

  private async executeOpenPhase(state: BotRuntimeState) {
    const pending = state.pendingRebalance;
    if (!pending) return;

    const poolAddress = this.options.poolAddress!;
    const binStep = this.options.binStep ?? 1;
    const strategy = this.options.strategy ?? "Spot";
    const tokenAMint = this.options.tokenAMint ?? "";
    const tokenBMint = this.options.tokenBMint ?? "";
    const tokenADecimals = this.options.tokenADecimals ?? 9;
    const tokenBDecimals = this.options.tokenBDecimals ?? 6;

    // If previous position is somehow still live, go back to closing
    if (pending.previousPositionAddress) {
      const previousStillLive = await this.meteoraClient.findManagedPosition(poolAddress, pending.previousPositionAddress);
      if (previousStillLive) {
        pending.phase = "closing";
        pending.plannedPositionAddress = null;
        pending.nextRetryAt = null;
        pending.recoveryReason = "Previous position is still live on-chain; retrying close";
        state.latestAction = "previous position still open; retrying close before opening";
        await this.stateStore.save(state);
        this.logger.warn(
          { phase: "opening", previousPositionAddress: pending.previousPositionAddress },
          "refusing to open a replacement while the previous position is still live"
        );
        return;
      }
    }

    try {
      let balances = await this.meteoraClient.getWalletBalances(tokenAMint, tokenBMint);
      balances = await this.capBalancesToAllocation(pending.targetCenterPrice, balances);

      // Reserve SOL for position account rent and transaction fees (~0.1 SOL)
      const RENT_RESERVE_LAMPORTS = 100_000_000n;
      if (tokenAMint === "So11111111111111111111111111111111111111112" && balances.tokenA > RENT_RESERVE_LAMPORTS) {
        balances = { ...balances, tokenA: balances.tokenA - RENT_RESERVE_LAMPORTS };
      } else if (tokenBMint === "So11111111111111111111111111111111111111112" && balances.tokenB > RENT_RESERVE_LAMPORTS) {
        balances = { ...balances, tokenB: balances.tokenB - RENT_RESERVE_LAMPORTS };
      }

      // Measure deployed value after all swaps to baseline entry capital
      const deployedValue = this.quoteValue(pending.targetCenterPrice, balances.tokenA, balances.tokenB, tokenADecimals, tokenBDecimals);
      if (pending.entryCapitalQuote != null) {
        pending.cumulativeSwapFeeQuote = Math.max(0, pending.entryCapitalQuote - deployedValue);
      }
      pending.entryCapitalQuote = deployedValue;
      pending.entryTokenA = balances.tokenA.toString();
      pending.entryTokenB = balances.tokenB.toString();

      const { lowerBinId, upperBinId } = this.computeTargetBinRange(pending.targetCenterPrice, state.driftDirection);
      const deploymentBufferBps = this.resolveDeploymentBufferBps(pending.openFailureCount);

      const openResult = await this.meteoraClient.openPosition({
        poolAddress,
        lowerBinId,
        upperBinId,
        tokenAAmount: balances.tokenA,
        tokenBAmount: balances.tokenB,
        strategy,
        execute: true,
        deploymentBufferBps
      });

      pending.plannedPositionAddress = openResult.positionAddress;
      pending.lastKnownOpenTxId = openResult.txId;
      const openSummary = await this.inspectTransaction(openResult.txId);

      // Compute actual deployed capital (after deployment buffer reduction)
      const bufferFactor = deploymentBufferBps ? (10_000 - deploymentBufferBps) / 10_000 : 1;
      const actualEntryCapital = deployedValue * bufferFactor;
      const actualTokenA = BigInt(Math.floor(Number(balances.tokenA) * bufferFactor));
      const actualTokenB = BigInt(Math.floor(Number(balances.tokenB) * bufferFactor));

      // Record PNL
      if (this.options.onPositionOpened && openResult.positionAddress !== "dry-run") {
        try {
          await this.options.onPositionOpened({
            botId: this.options.botId ?? "legacy",
            botName: this.options.botName ?? "Bot",
            dlmmPoolAddress: poolAddress,
            tokenPair: `${this.options.tokenASymbol ?? "?"}/${this.options.tokenBSymbol ?? "?"}`,
            positionAddress: openResult.positionAddress,
            openedAt: new Date().toISOString(),
            centerPrice: pending.targetCenterPrice,
            lowerPrice: openResult.lowerPrice,
            upperPrice: openResult.upperPrice,
            entryCapitalQuote: actualEntryCapital,
            entryTokenA: actualTokenA.toString(),
            entryTokenB: actualTokenB.toString(),
            residualTokenA: "0",
            residualTokenB: "0",
            cumulativeSwapFeeQuote: pending.cumulativeSwapFeeQuote,
            cumulativeTxFeeLamports: pending.cumulativeTxFeeLamports + (openSummary?.feeLamports ?? 0),
            openTxId: openResult.txId
          });
        } catch (error) {
          this.logger.warn({ error: (error as Error).message }, "position open pnl update failed");
        }
      }

      await this.finalizeRebalance(
        state,
        openResult.positionAddress,
        openResult.lowerBinId,
        openResult.upperBinId,
        openResult.lowerPrice,
        openResult.upperPrice
      );
    } catch (error) {
      if (await this.handleOpenTimeout(state, error)) return;
      if (await this.handleRetryableOpenFailure(state, error)) return;
      if (await this.handleRecoverableRpcFailure(state, error)) return;
      await this.pauseAfterFailure(state, error);
    }
  }

  // ── Timeout/Error Handlers ───────────────────────────────────

  private async handleCloseTimeout(state: BotRuntimeState, error: unknown) {
    const pending = state.pendingRebalance;
    if (!pending || !this.isTimeoutError(error, "closing")) return false;

    const poolAddress = this.options.poolAddress!;
    pending.recoveryReason = (error as Error).message;
    await this.stateStore.save(state);
    this.logTimeoutDetected("closing", error, pending);

    const livePosition = pending.previousPositionAddress
      ? await this.meteoraClient.findManagedPosition(poolAddress, pending.previousPositionAddress)
      : null;
    const outcome = classifyCloseTimeout(
      pending.previousPositionAddress,
      livePosition?.positionAddress ?? null
    );

    this.logger.info(
      { phase: "closing", outcome, previousPositionAddress: pending.previousPositionAddress },
      "timeout reconciliation evaluated"
    );

    if (outcome === "continue") {
      await this.advancePendingPhase(state, "swapping", "recovered from close timeout");
      return true;
    }

    if (pending.retryCount < RebalancerService.MAX_TIMEOUT_RETRIES) {
      pending.retryCount += 1;
      state.latestAction = "retrying close after timeout";
      await this.stateStore.save(state);
      await this.executeClosePhase(state);
      return true;
    }

    await this.pauseForAmbiguousPhase(state, "closing", (error as Error).message);
    return true;
  }

  private async handleMissingClosePosition(state: BotRuntimeState, error: unknown) {
    const pending = state.pendingRebalance;
    const message = (error as Error).message ?? "";
    if (!pending || pending.phase !== "closing" || !pending.previousPositionAddress || !this.isMissingAccountError(message)) {
      return false;
    }

    const poolAddress = this.options.poolAddress!;
    const livePosition = await this.meteoraClient.findManagedPosition(poolAddress, pending.previousPositionAddress);
    if (livePosition) return false;

    this.logger.warn(
      { phase: "closing", previousPositionAddress: pending.previousPositionAddress, error: message },
      "close account missing and position is already gone on-chain; continuing"
    );

    await this.advancePendingPhase(state, "swapping", "position inferred closed after missing account");
    return true;
  }

  private async handleRecoverableRpcFailure(state: BotRuntimeState, error: unknown) {
    const pending = state.pendingRebalance;
    if (!pending || !isRecoverableRpcError(error)) return false;

    pending.retryCount += 1;
    pending.recoveryReason = (error as Error).message;

    if (pending.retryCount >= RebalancerService.MAX_RECOVERABLE_RPC_RETRIES && pending.phase !== "closing") {
      this.logger.warn(
        { phase: pending.phase, attempt: pending.retryCount, error: (error as Error).message },
        "recoverable rpc retry budget exhausted; releasing stale pending rebalance"
      );
      state.pendingRebalance = null;
      state.inFlightRebalance = false;
      state.latestAction = "recoverable rpc retries exhausted; retrying from a fresh cycle";
      state.driftStatus = "triggered";
      state.driftDirection = null;
      await this.stateStore.save(state);
      return true;
    }

    pending.nextRetryAt = new Date(
      Date.now() + Math.min(
        RebalancerService.MAX_RPC_RETRY_BACKOFF_MS,
        RebalancerService.RPC_RETRY_BACKOFF_MS * Math.max(1, pending.retryCount)
      )
    ).toISOString();
    state.latestAction = `retrying ${pending.phase} after recoverable rpc failure`;
    await this.stateStore.save(state);

    this.logger.warn(
      { phase: pending.phase, attempt: pending.retryCount, error: (error as Error).message, nextRetryAt: pending.nextRetryAt },
      "recoverable rpc failure; retrying automatically"
    );
    return true;
  }

  private async handleRetryableCloseFailure(state: BotRuntimeState, error: unknown) {
    const pending = state.pendingRebalance;
    const message = (error as Error).message ?? "";
    if (!pending || pending.phase !== "closing" || !this.isRetryableCloseSimulationFailure(message)) return false;

    const poolAddress = this.options.poolAddress!;
    const livePosition = pending.previousPositionAddress
      ? await this.meteoraClient.findManagedPosition(poolAddress, pending.previousPositionAddress)
      : null;

    if (!livePosition) {
      await this.advancePendingPhase(state, "swapping", "position inferred closed after close simulation failure");
      return true;
    }

    pending.retryCount += 1;
    pending.recoveryReason = message;
    pending.nextRetryAt = new Date(
      Date.now() + Math.min(
        RebalancerService.MAX_CLOSE_RETRY_BACKOFF_MS,
        RebalancerService.CLOSE_RETRY_BACKOFF_MS * Math.max(1, pending.retryCount)
      )
    ).toISOString();
    state.latestAction = "retrying close after simulation failure";
    await this.stateStore.save(state);
    return true;
  }

  private async handleRetryableOpenFailure(state: BotRuntimeState, error: unknown) {
    const pending = state.pendingRebalance;
    const message = (error as Error).message ?? "";
    if (!pending || pending.phase !== "opening" || !this.isRetryableOpenFailure(message)) return false;

    pending.retryCount += 1;
    pending.openFailureCount += 1;
    pending.phase = "swapping";
    pending.recoveryReason = message;
    pending.entryCapitalQuote = null;
    pending.entryTokenA = null;
    pending.entryTokenB = null;
    pending.nextRetryAt = new Date(
      Date.now() + Math.min(
        RebalancerService.MAX_OPEN_RETRY_BACKOFF_MS,
        RebalancerService.OPEN_RETRY_BACKOFF_MS * Math.max(1, pending.retryCount)
      )
    ).toISOString();
    state.latestAction = "retrying rebalance before open after simulation failure";
    await this.stateStore.save(state);

    this.logger.warn(
      { phase: "opening", attempt: pending.retryCount, openFailureCount: pending.openFailureCount, error: message },
      "open simulation failed; scheduled rebalance retry"
    );
    return true;
  }

  private async handleRetryableSwapFailure(state: BotRuntimeState, error: unknown) {
    const pending = state.pendingRebalance;
    const message = (error as Error).message ?? "";
    if (!pending || pending.phase !== "swapping" || !message.includes("Transaction simulation failed:")) return false;

    pending.retryCount += 1;
    pending.recoveryReason = message;
    pending.nextRetryAt = new Date(
      Date.now() + Math.min(
        RebalancerService.MAX_OPEN_RETRY_BACKOFF_MS,
        RebalancerService.OPEN_RETRY_BACKOFF_MS * Math.max(1, pending.retryCount)
      )
    ).toISOString();
    state.latestAction = "retrying swap after simulation failure";
    await this.stateStore.save(state);
    return true;
  }

  private async handleSwapTimeout(state: BotRuntimeState, error: unknown) {
    const pending = state.pendingRebalance;
    if (!pending || !this.isTimeoutError(error, "swapping")) return false;

    pending.recoveryReason = (error as Error).message;
    await this.stateStore.save(state);
    this.logTimeoutDetected("swapping", error, pending);

    // After a swap timeout, check if we need another swap
    const outcome = classifySwapTimeout(true);

    if (outcome === "continue") {
      await this.advancePendingPhase(state, "opening", "recovered from swap timeout");
      return true;
    }

    if (pending.retryCount < RebalancerService.MAX_TIMEOUT_RETRIES) {
      pending.retryCount += 1;
      state.latestAction = "retrying swap after timeout";
      await this.stateStore.save(state);
      await this.executeSwapPhase(state);
      return true;
    }

    await this.pauseForAmbiguousPhase(state, "swapping", (error as Error).message);
    return true;
  }

  private async handleOpenTimeout(state: BotRuntimeState, error: unknown) {
    const pending = state.pendingRebalance;
    if (!pending || !this.isTimeoutError(error, "opening")) return false;

    const poolAddress = this.options.poolAddress!;
    pending.recoveryReason = (error as Error).message;
    await this.stateStore.save(state);
    this.logTimeoutDetected("opening", error, pending);

    // Check if a new position was created on-chain
    const positions = await this.meteoraClient.listPositions(poolAddress);
    const newPosition = positions.find((p) =>
      p.positionAddress !== pending.previousPositionAddress &&
      (pending.plannedPositionAddress ? p.positionAddress === pending.plannedPositionAddress : true)
    );

    const outcome = classifyOpenTimeout({
      livePositionAddress: newPosition?.positionAddress ?? null,
      previousPositionAddress: pending.previousPositionAddress,
      plannedPositionAddress: pending.plannedPositionAddress
    });

    this.logger.info(
      { phase: "opening", outcome, newPositionAddress: newPosition?.positionAddress ?? null },
      "timeout reconciliation evaluated"
    );

    if (outcome === "complete" && newPosition) {
      const binStep = this.options.binStep ?? 1;
      await this.finalizeRebalance(
        state,
        newPosition.positionAddress,
        newPosition.lowerBinId,
        newPosition.upperBinId,
        binIdToPrice(newPosition.lowerBinId, binStep, this.decimalAdjust),
        binIdToPrice(newPosition.upperBinId, binStep, this.decimalAdjust)
      );
      return true;
    }

    if (pending.retryCount < RebalancerService.MAX_TIMEOUT_RETRIES) {
      pending.retryCount += 1;
      state.latestAction = "retrying open after timeout";
      await this.stateStore.save(state);
      await this.executeOpenPhase(state);
      return true;
    }

    await this.pauseForAmbiguousPhase(state, "opening", (error as Error).message);
    return true;
  }

  // ── Helpers ──────────────────────────────────────────────────

  private get decimalAdjust(): number {
    return (this.options.tokenADecimals ?? 9) - (this.options.tokenBDecimals ?? 6);
  }

  private computeTargetBinRange(centerPrice: number, driftDirection?: import("../domain.js").DriftDirection | null) {
    const binStep = this.options.binStep ?? 1;
    const rangeBins = this.options.rangeBins;

    if (rangeBins && rangeBins > 0) {
      // Use explicit bin count for a tighter, centered range
      const halfWidthBins = Math.floor(rangeBins / 2);
      const range = computeCenteredBinRange(centerPrice, halfWidthBins, binStep, this.decimalAdjust);

      // Apply trend shift: offset the range center in the drift direction
      const trendShift = this.options.trendShiftBins ?? 0;
      if (trendShift > 0 && driftDirection) {
        const offset = driftDirection === "below" ? -trendShift : trendShift;
        range.lowerBinId += offset;
        range.upperBinId += offset;
      }

      return range;
    }

    // Fallback: derive from min/max config (original behavior)
    const configMin = this.options.minPrice ?? centerPrice * 0.95;
    const configMax = this.options.maxPrice ?? centerPrice * 1.05;
    const halfWidth = (configMax - configMin) / 2;
    const newMin = centerPrice - halfWidth;
    const newMax = centerPrice + halfWidth;
    return computeBinRange(newMin, newMax, binStep, this.decimalAdjust);
  }

  private resolveDeploymentBufferBps(openFailureCount: number): number {
    if (openFailureCount >= 2 * this.config.SLIPPAGE_RETRIES_PER_TIER) {
      return this.config.OPEN_FINAL_DEPLOYMENT_BUFFER_BPS;
    }
    if (openFailureCount >= this.config.SLIPPAGE_RETRIES_PER_TIER) {
      return this.config.OPEN_RETRY_DEPLOYMENT_BUFFER_BPS;
    }
    return this.config.OPEN_DEPLOYMENT_BUFFER_BPS;
  }

  private async finalizeRebalance(
    state: BotRuntimeState,
    positionAddress: string,
    lowerBinId: number,
    upperBinId: number,
    lowerPrice: number,
    upperPrice: number
  ) {
    const pending = state.pendingRebalance;
    const targetCenterPrice = pending?.targetCenterPrice ?? state.lastObservedPrice ?? 0;

    state.activePositionAddress = positionAddress;
    state.activeLowerBinId = lowerBinId;
    state.activeUpperBinId = upperBinId;
    state.lastRebalanceAt = new Date().toISOString();
    state.lastCenterPrice = targetCenterPrice;
    state.positionLowerPrice = lowerPrice;
    state.positionUpperPrice = upperPrice;
    state.pendingRebalance = null;
    state.inFlightRebalance = false;
    state.driftStatus = null;
    state.driftDirection = null;
    state.latestAction = "rebalance complete";
    state.lastPnlMarkAt = new Date().toISOString();

    // Update min/max to match the new position range so drift detection
    // uses the re-centered range instead of the stale config values
    this.options.minPrice = lowerPrice;
    this.options.maxPrice = upperPrice;
    if (this.options.onRangeUpdated) {
      try {
        await this.options.onRangeUpdated(lowerPrice, upperPrice);
      } catch (e) {
        this.logger.warn({ error: (e as Error).message }, "failed to persist range update");
      }
    }

    await this.stateStore.save(state);

    this.logger.info(
      {
        positionAddress,
        lowerBinId,
        upperBinId,
        lowerPrice,
        upperPrice,
        centerPrice: targetCenterPrice
      },
      "rebalance finished"
    );
  }

  private async advancePendingPhase(state: BotRuntimeState, nextPhase: RebalancePhase, reason: string) {
    const pending = state.pendingRebalance;
    if (!pending) return;

    pending.phase = nextPhase;
    pending.retryCount = 0;
    pending.nextRetryAt = null;
    pending.recoveryReason = null;
    state.latestAction = reason;
    await this.stateStore.save(state);

    this.logger.info({ nextPhase, reason }, "advanced pending rebalance phase");
  }

  private async pauseAfterFailure(state: BotRuntimeState, error: unknown) {
    const message = (error as Error).message ?? String(error);
    state.paused = true;
    state.pauseReason = message;
    state.inFlightRebalance = false;
    state.latestAction = `paused: ${message.slice(0, 200)}`;
    await this.stateStore.save(state);

    this.logger.error(
      { error: message, phase: state.pendingRebalance?.phase ?? "unknown" },
      "rebalance paused after failure"
    );
  }

  private async pauseForAmbiguousPhase(state: BotRuntimeState, phase: RebalancePhase, errorMessage: string) {
    const reason = `Ambiguous ${phase} state after timeout: ${errorMessage.slice(0, 200)}`;
    state.paused = true;
    state.pauseReason = reason;
    state.latestAction = reason;
    await this.stateStore.save(state);

    this.logger.error({ phase, reason }, "paused for ambiguous phase");
  }

  private async capBalancesToAllocation(currentPrice: number, balances: WalletBalances): Promise<WalletBalances> {
    if (!this.options.resolveAllocationQuoteBudget) return balances;

    const budget = await this.options.resolveAllocationQuoteBudget(currentPrice);
    if (!budget || !Number.isFinite(budget) || budget <= 0) return balances;

    const tokenADecimals = this.options.tokenADecimals ?? 9;
    const tokenBDecimals = this.options.tokenBDecimals ?? 6;
    const currentValueQuote = this.quoteValue(currentPrice, balances.tokenA, balances.tokenB, tokenADecimals, tokenBDecimals);

    if (currentValueQuote <= budget) return balances;

    const scaleFactor = budget / currentValueQuote;
    return {
      tokenA: BigInt(Math.floor(Number(balances.tokenA) * scaleFactor)),
      tokenB: BigInt(Math.floor(Number(balances.tokenB) * scaleFactor))
    };
  }

  private quoteValue(currentPrice: number, tokenA: bigint, tokenB: bigint, tokenADecimals: number, tokenBDecimals: number): number {
    return fromBaseUnits(tokenA, tokenADecimals) * currentPrice + fromBaseUnits(tokenB, tokenBDecimals);
  }

  private async waitForPostCloseBalances(owner: string, tokenAMint: string, tokenBMint: string): Promise<WalletBalances> {
    const deadline = Date.now() + RebalancerService.POST_CLOSE_BALANCE_WAIT_MS;
    let balances = await this.accountReader.getWalletBalances(owner, tokenAMint, tokenBMint);

    while (Date.now() < deadline) {
      if (balances.tokenA > 0n || balances.tokenB > 0n) return balances;
      await this.sleep(RebalancerService.POST_CLOSE_BALANCE_POLL_MS);
      balances = await this.accountReader.getWalletBalances(owner, tokenAMint, tokenBMint);
    }

    return balances;
  }

  private async inspectTransaction(txId: string | null) {
    if (!txId) return null;
    try {
      return await this.transactionInspector.inspect(txId);
    } catch {
      return null;
    }
  }

  private async runExclusive<T>(reason: "trigger" | "manual" | "recovery", task: () => Promise<T>) {
    if (this.options.runExclusive) {
      return this.options.runExclusive(reason, task);
    }
    return task();
  }

  private shouldRecoverPausedPendingRebalance(state: BotRuntimeState): boolean {
    return shouldRecoverPausedTimeout(state.pauseReason, state.pendingRebalance);
  }

  private normalizePendingRebalance(pending: PendingRebalance) {
    pending.retryCount = pending.retryCount ?? 0;
    pending.openFailureCount = pending.openFailureCount ?? 0;
    pending.cumulativeSwapFeeQuote = pending.cumulativeSwapFeeQuote ?? 0;
    pending.cumulativeTxFeeLamports = pending.cumulativeTxFeeLamports ?? 0;
    pending.entryCapitalQuote = pending.entryCapitalQuote ?? null;
    pending.entryTokenA = pending.entryTokenA ?? null;
    pending.entryTokenB = pending.entryTokenB ?? null;
  }

  private isTimeoutError(error: unknown, _phase: RebalancePhase) {
    const message = (error as Error).message ?? "";
    return (
      error instanceof TransactionTimeoutError
    ) || (
      message.includes(RebalancerService.TIMEOUT_TEXT)
    ) || (
      message.includes(RebalancerService.BLOCK_HEIGHT_TEXT)
    );
  }

  private isTimeoutMessage(message: string | null) {
    if (!message) return false;
    return message.includes(RebalancerService.TIMEOUT_TEXT) || message.includes(RebalancerService.BLOCK_HEIGHT_TEXT);
  }

  private isMissingAccountError(message: string) {
    return message.includes("Account does not exist") || message.includes("could not find account");
  }

  private isRetryableCloseSimulationFailure(message: string) {
    return message.includes("Transaction simulation failed:");
  }

  private isRetryableOpenFailure(message: string) {
    return (
      message.includes("Transaction simulation failed:") ||
      message.includes("0x1") ||
      message.includes("insufficient")
    );
  }

  private logTimeoutDetected(phase: RebalancePhase, error: unknown, pending: PendingRebalance) {
    this.logger.warn(
      {
        phase,
        error: (error as Error).message,
        retryCount: pending.retryCount,
        previousPositionAddress: pending.previousPositionAddress,
        plannedPositionAddress: pending.plannedPositionAddress
      },
      "transaction timeout detected"
    );
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
