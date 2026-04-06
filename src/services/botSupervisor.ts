import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { Logger } from "pino";

import { buildBotConfig } from "../botConfig.js";
import type { AppConfig } from "../config.js";
import type {
  BotDefinition,
  BotId,
  BotRecord,
  ExecutionQueueJob,
  GlobalPnlSummary,
  PositionPnlRecord,
  WalletAllocationSummary
} from "../domain.js";
import { RpcAccountReader } from "../infra/rpcAccountReader.js";
import { isRecoverableRpcError } from "../infra/rpcFailover.js";
import { TransactionInspector } from "../infra/transactionInspector.js";
import { MeteoraClient, type CompoundFeesResult } from "../clients/meteoraClient.js";
import { RebalancerService } from "./rebalancer.js";
import { PositionPnlService, type PnlDashboardSnapshot } from "./positionPnlService.js";
import { resolveTokenPricesUsdc, resolveTokenPricesUsdcStrict } from "./pnlMath.js";
import {
  BotRegistryStore,
  BotRuntimeStore,
  type CreateBotInput,
  type UpdateBotInput
} from "../state/botRegistryStore.js";
import { PnlLedgerStore } from "../state/pnlLedgerStore.js";

interface BotRunner {
  timer: NodeJS.Timeout | null;
  inTick: boolean;
  service: RebalancerService;
  client: MeteoraClient;
}

export class BotSupervisor {
  private static readonly RECOVERABLE_ERROR_BACKOFF_MS = 30_000;
  private static readonly SOL_MINT = "So11111111111111111111111111111111111111112";
  private static readonly USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  private readonly runners = new Map<BotId, BotRunner>();
  private readonly accountReader: RpcAccountReader;
  private readonly transactionInspector: TransactionInspector;
  private readonly sharedClient: MeteoraClient;
  private readonly pnlService: PositionPnlService;
  private readonly queue: ExecutionQueueJob[] = [];
  private executionTail: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly registryStore: BotRegistryStore
  ) {
    this.accountReader = new RpcAccountReader(config.solanaRpcUrls);
    this.transactionInspector = new TransactionInspector(config.solanaRpcUrls);
    this.sharedClient = new MeteoraClient(config, logger);
    this.pnlService = new PositionPnlService(
      new PnlLedgerStore(config.BOT_PNL_LEDGER_FILE),
      logger,
      async (bot, bots, currentPrice) =>
        resolveTokenPricesUsdcStrict(bot, currentPrice, bots) ??
        await this.resolveTokenPricesUsdcWithLiveReference(bot, currentPrice, bots) ??
        resolveTokenPricesUsdc(bot, currentPrice, bots)
    );
  }

  async init() {
    if (this.initialized) return;

    await this.sharedClient.init();
    const bots = await this.registryStore.listBots();
    for (const bot of bots) {
      await this.ensureRunner(bot);
      if (bot.definition.enabled && bot.runtime.monitoringActive) {
        this.scheduleNextTick(bot.definition.id, 0);
      }
    }

    this.initialized = true;
  }

  async listBots(): Promise<BotRecord[]> {
    await this.init();
    return this.registryStore.listBots();
  }

  async getBot(botId: BotId): Promise<BotRecord | null> {
    await this.init();
    return this.registryStore.getBot(botId);
  }

  async createBot(input: CreateBotInput): Promise<BotRecord> {
    await this.init();
    const metadata = await this.sharedClient.discoverPoolMetadata(input.dlmmPoolAddress);
    const record = await this.registryStore.createBot(input, metadata);
    await this.ensureRunner(record);
    return record;
  }

  async updateBot(botId: BotId, input: UpdateBotInput): Promise<BotRecord | null> {
    await this.init();
    const updated = await this.registryStore.updateBot(botId, input);
    if (!updated) return null;

    await this.ensureRunner(updated, true);

    if (!updated.definition.enabled || !updated.runtime.monitoringActive) {
      this.clearTimer(botId);
    } else {
      this.scheduleNextTick(botId, 0);
    }

    return updated;
  }

  async archiveBot(botId: BotId): Promise<BotRecord | null> {
    await this.init();
    this.clearTimer(botId);
    return this.registryStore.archiveBot(botId);
  }

  async startBot(botId: BotId): Promise<BotRecord | null> {
    const record = await this.updateBot(botId, {
      enabled: true,
      monitoringActive: true,
      resetPause: true
    });
    if (record) {
      this.scheduleNextTick(botId, 0);
    }
    return record;
  }

  async stopBot(botId: BotId): Promise<BotRecord | null> {
    this.clearTimer(botId);
    return this.updateBot(botId, { monitoringActive: false });
  }

  async pauseBot(botId: BotId, reason = "Paused from control panel"): Promise<BotRecord | null> {
    this.clearTimer(botId);
    return this.updateBot(botId, {
      paused: true,
      monitoringActive: false,
      pauseReason: reason
    });
  }

  async resumeBot(botId: BotId): Promise<BotRecord | null> {
    return this.resumeBotInternal(botId, true);
  }

  async rebalanceNow(botId: BotId): Promise<void> {
    await this.init();
    const runner = await this.ensureRunnerById(botId);
    await runner.service.runCycle("rebalance-now");
  }

  async closePositionNow(botId: BotId): Promise<{ positionAddress: string; txId: string | null } | null> {
    await this.init();
    const runner = await this.ensureRunnerById(botId);
    return runner.service.closePositionOnly();
  }

  async compoundFees(botId: BotId): Promise<CompoundFeesResult | null> {
    await this.init();
    const runner = await this.ensureRunnerById(botId);
    return runner.service.compoundFees();
  }

  async getWalletSummary(): Promise<WalletAllocationSummary> {
    await this.init();
    const bots = await this.registryStore.listBots();
    const enabledBots = bots.filter((bot) => bot.definition.enabled && !bot.definition.archived);
    const monitoringBots = enabledBots.filter((bot) => bot.runtime.monitoringActive);
    const totalAllocatedUsdc = enabledBots.reduce((sum, bot) => sum + bot.definition.allocationUsdc, 0);

    return {
      walletAddress: this.sharedClient.getOwnerAddress(),
      enabledBots: enabledBots.length,
      monitoringBots: monitoringBots.length,
      totalAllocatedUsdc,
      availableTokenA: null,
      availableTokenB: null,
      queueDepth: this.queue.length,
      overAllocated: false
    };
  }

  async getPnlDashboard(): Promise<PnlDashboardSnapshot> {
    await this.init();
    const bots = await this.registryStore.listBots();
    const livePositions = await this.sharedClient.listAllOwnerPositions();
    return this.pnlService.getDashboardSnapshot(bots, livePositions);
  }

  async getTransactions(logPath: string, botId?: BotId) {
    try {
      const raw = await readFile(logPath, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      return lines
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
        .filter((entry) => !botId || entry.botId === botId);
    } catch {
      return [];
    }
  }

  private async resumeBotInternal(botId: BotId, scheduleNextTick: boolean): Promise<BotRecord | null> {
    const record = await this.getBot(botId);
    if (!record) return null;

    record.runtime.paused = false;
    record.runtime.pauseReason = null;
    record.runtime.monitoringActive = true;
    record.definition.enabled = true;
    await this.registryStore.saveRuntime(botId, record.runtime);
    await this.registryStore.updateBot(botId, {
      enabled: true,
      monitoringActive: true,
      resetPause: true
    });
    if (scheduleNextTick) {
      this.scheduleNextTick(botId, 0);
    }
    return this.registryStore.getBot(botId);
  }

  private async ensureRunnerById(botId: BotId): Promise<BotRunner> {
    const record = await this.registryStore.getBot(botId);
    if (!record) {
      throw new Error(`Bot ${botId} not found`);
    }
    return this.ensureRunner(record);
  }

  private async ensureRunner(record: BotRecord, forceRefresh = false): Promise<BotRunner> {
    const existing = this.runners.get(record.definition.id);
    if (existing && !forceRefresh) return existing;

    if (existing) {
      this.clearTimer(record.definition.id);
    }

    const botConfig = buildBotConfig(this.config, record.definition);
    const botLogger = this.logger.child({
      botId: record.definition.id,
      botName: record.definition.name,
      dlmmPoolAddress: record.definition.dlmmPoolAddress
    });
    const stateStore = new BotRuntimeStore(this.registryStore, record.definition.id);
    const client = new MeteoraClient(botConfig, botLogger);
    await client.init();

    const runner: BotRunner = {
      timer: null,
      inTick: false,
      client,
      service: new RebalancerService(botConfig, botLogger, stateStore, client, {
        botId: record.definition.id,
        botName: record.definition.name,
        poolAddress: record.definition.dlmmPoolAddress,
        tokenAMint: record.definition.tokenAMint,
        tokenBMint: record.definition.tokenBMint,
        tokenADecimals: record.definition.tokenADecimals,
        tokenBDecimals: record.definition.tokenBDecimals,
        tokenASymbol: record.definition.tokenASymbol,
        tokenBSymbol: record.definition.tokenBSymbol,
        binStep: record.definition.binStep,
        minPrice: record.definition.minPrice,
        maxPrice: record.definition.maxPrice,
        strategy: record.definition.strategy,
        allocationUsdc: record.definition.allocationUsdc,
        autoCompound: record.definition.autoCompound,
        compoundMinValueQuote: record.definition.compoundMinValueUsdc,
        driftThresholdPct: record.definition.driftThresholdPct,
        rangeBins: record.definition.rangeBins,
        trendShiftBins: record.definition.trendShiftBins,
        runExclusive: (reason, task) => this.enqueue(record.definition.id, reason, task),
        listClaimedPositionAddresses: async () =>
          (await this.registryStore.listAllBots())
            .map((bot) => bot.runtime.activePositionAddress)
            .filter((addr): addr is string => Boolean(addr)),
        resolveAllocationQuoteBudget: async (currentPrice) => {
          const bots = await this.registryStore.listAllBots();
          const prices =
            resolveTokenPricesUsdcStrict(record.definition, currentPrice, bots) ??
            await this.resolveTokenPricesUsdcWithLiveReference(record.definition, currentPrice, bots);
          if (!prices || !Number.isFinite(prices.tokenBUsdc) || prices.tokenBUsdc <= 0) {
            botLogger.warn(
              { currentPrice, tokenAMint: record.definition.tokenAMint, tokenBMint: record.definition.tokenBMint },
              "allocation quote budget unavailable because token prices could not be resolved"
            );
            return null;
          }
          return record.definition.allocationUsdc / prices.tokenBUsdc;
        },
        onPositionClosed: async (input) => {
          await this.pnlService.recordPositionClosed(record.definition, await this.registryStore.listAllBots(), input);
        },
        onPositionOpened: async (input) => {
          await this.pnlService.recordPositionOpened(record.definition, await this.registryStore.listAllBots(), input);
        },
        onPositionMarked: async (input) => {
          await this.pnlService.markOpenPosition(record.definition, await this.registryStore.listAllBots(), input);
        },
        onRangeUpdated: async (newMin, newMax) => {
          record.definition.minPrice = newMin;
          record.definition.maxPrice = newMax;
          record.definition.updatedAt = new Date().toISOString();
          await this.registryStore.updateBot(record.definition.id, {
            minPrice: newMin,
            maxPrice: newMax
          });
        }
      })
    };

    this.runners.set(record.definition.id, runner);
    return runner;
  }

  private scheduleNextTick(botId: BotId, delayMs: number) {
    const runner = this.runners.get(botId);
    if (!runner) return;

    this.clearTimer(botId);
    const scheduledDelayMs = this.addScheduleJitter(delayMs);
    runner.timer = setTimeout(async () => {
      runner.timer = null;
      await this.tickBot(botId);
    }, scheduledDelayMs);
  }

  private clearTimer(botId: BotId) {
    const runner = this.runners.get(botId);
    if (!runner?.timer) return;
    clearTimeout(runner.timer);
    runner.timer = null;
  }

  private async tickBot(botId: BotId) {
    const record = await this.registryStore.getBot(botId);
    const runner = this.runners.get(botId);

    if (!record || !runner || record.definition.archived || !record.definition.enabled || !record.runtime.monitoringActive) {
      return;
    }

    if (runner.inTick) {
      this.scheduleNextTick(botId, record.definition.pollSeconds * 1000);
      return;
    }

    runner.inTick = true;
    let nextDelayMs = record.definition.pollSeconds * 1000;
    try {
      await runner.service.runCycle("run");
    } catch (error) {
      if (isRecoverableRpcError(error)) {
        nextDelayMs = Math.max(nextDelayMs * 2, BotSupervisor.RECOVERABLE_ERROR_BACKOFF_MS);
        this.logger.warn(
          { botId, error: (error as Error).message, retryInMs: nextDelayMs },
          "recoverable rpc error in bot tick; backing off next poll"
        );
      }

      this.logger.error({ botId, error: (error as Error).message }, "bot tick failed");
    } finally {
      if (runner) {
        runner.inTick = false;
      }
      const latest = await this.registryStore.getBot(botId);
      if (latest?.definition.enabled && latest.runtime.monitoringActive) {
        this.scheduleNextTick(botId, nextDelayMs);
      }
    }
  }

  private async enqueue<T>(botId: BotId, reason: "trigger" | "manual" | "recovery", task: () => Promise<T>) {
    const job: ExecutionQueueJob = {
      id: randomUUID(),
      botId,
      reason,
      enqueuedAt: new Date().toISOString()
    };
    this.queue.push(job);

    const run = this.executionTail.then(task, task);
    this.executionTail = run.then(
      () => undefined,
      () => undefined
    );

    try {
      return await run;
    } finally {
      const index = this.queue.findIndex((candidate) => candidate.id === job.id);
      if (index >= 0) {
        this.queue.splice(index, 1);
      }
    }
  }

  private addScheduleJitter(delayMs: number) {
    if (delayMs <= 0) {
      return 250 + Math.floor(Math.random() * 2_250);
    }
    const jitterMs = Math.min(2_500, Math.max(250, Math.floor(delayMs * 0.15)));
    return delayMs + Math.floor(Math.random() * jitterMs);
  }

  private async resolveTokenPricesUsdcWithLiveReference(
    bot: BotDefinition,
    currentPrice: number,
    bots: BotRecord[]
  ) {
    const liveSolUsdc = await this.resolveLiveSolUsdcPrice(bots);
    if (!liveSolUsdc || !Number.isFinite(liveSolUsdc) || liveSolUsdc <= 0) return null;

    if (bot.tokenAMint === BotSupervisor.SOL_MINT) {
      return { tokenAUsdc: liveSolUsdc, tokenBUsdc: liveSolUsdc / currentPrice, solUsdc: liveSolUsdc };
    }

    if (bot.tokenBMint === BotSupervisor.SOL_MINT) {
      return { tokenAUsdc: currentPrice * liveSolUsdc, tokenBUsdc: liveSolUsdc, solUsdc: liveSolUsdc };
    }

    return null;
  }

  private async resolveLiveSolUsdcPrice(bots: BotRecord[]) {
    const referenceBot = bots.find((bot) => {
      const { tokenAMint, tokenBMint } = bot.definition;
      return (
        (tokenAMint === BotSupervisor.SOL_MINT && tokenBMint === BotSupervisor.USDC_MINT) ||
        (tokenAMint === BotSupervisor.USDC_MINT && tokenBMint === BotSupervisor.SOL_MINT)
      );
    });

    if (!referenceBot) {
      return this.fetchFallbackSolUsdcPrice();
    }

    try {
      const runner = await this.ensureRunner(referenceBot);
      const snapshot = await runner.client.fetchPoolSnapshot(referenceBot.definition.dlmmPoolAddress);

      if (referenceBot.definition.tokenAMint === BotSupervisor.SOL_MINT) {
        return snapshot.currentPrice;
      }
      return 1 / snapshot.currentPrice;
    } catch (error) {
      this.logger.warn(
        {
          botId: referenceBot.definition.id,
          dlmmPoolAddress: referenceBot.definition.dlmmPoolAddress,
          error: (error as Error).message
        },
        "failed to fetch live SOL/USD reference price"
      );
      return this.fetchFallbackSolUsdcPrice();
    }
  }

  private async fetchFallbackSolUsdcPrice() {
    try {
      return await this.sharedClient.getSolUsdcPrice();
    } catch (error) {
      this.logger.warn({ error: (error as Error).message }, "failed to fetch fallback SOL/USD price");
      return null;
    }
  }
}
