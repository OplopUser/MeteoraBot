import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import type { BotRuntimeState, PendingRebalance } from "../src/domain.js";
import { RebalancerService } from "../src/services/rebalancer.js";

const POOL = "BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y";
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const config = {
  solanaRpcUrls: ["http://127.0.0.1:1"],
  POLL_SECONDS: 15,
  MAX_SLIPPAGE_BPS: 100,
  OPEN_BALANCE_TOLERANCE_BPS: 25,
  OPEN_DEPLOYMENT_BUFFER_BPS: 100,
  OPEN_RETRY_DEPLOYMENT_BUFFER_BPS: 300,
  OPEN_FINAL_DEPLOYMENT_BUFFER_BPS: 500,
  SLIPPAGE_RETRIES_PER_TIER: 3
} as unknown as AppConfig;

function pending(phase: PendingRebalance["phase"]): PendingRebalance {
  return {
    phase,
    startedAt: new Date().toISOString(),
    nextRetryAt: null,
    anchorPrice: 100,
    targetCenterPrice: 100,
    previousPositionAddress: null,
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
}

function setup(phase: PendingRebalance["phase"], resolveBudget: () => Promise<number | null>) {
  let state = {
    activePositionAddress: null,
    activeLowerBinId: null,
    activeUpperBinId: null,
    lastRebalanceAt: null,
    lastCenterPrice: 100,
    latestAction: null,
    lastPnlMarkAt: null,
    paused: false,
    pauseReason: null,
    inFlightRebalance: true,
    lastObservedPrice: 100,
    driftDirection: null,
    driftStatus: "triggered",
    pendingRebalance: pending(phase),
    positionLowerPrice: null,
    positionUpperPrice: null,
    monitoringActive: true,
    lastCycleAt: null
  } as unknown as BotRuntimeState;

  const stateStore = {
    load: async () => structuredClone(state),
    save: async (next: BotRuntimeState) => {
      state = structuredClone(next);
    }
  };
  // 10 SOL + 1000 USDC in the wallet, i.e. ~$2000 at a price of 100.
  const balances = { tokenA: 10_000_000_000n, tokenB: 1_000_000_000n };
  const openPosition = vi.fn(async () => {
    throw new Error("test stub: open not executed");
  });
  const swap = vi.fn();
  const meteoraClient = {
    fetchPoolSnapshot: async () => ({ currentPrice: 100, activeBinId: 0 }),
    getOwnerAddress: () => "owner",
    getWalletBalances: async () => balances,
    findManagedPosition: async () => null,
    listPositions: async () => [],
    openPosition,
    getJupiterClient: () => ({ swap })
  };

  const service = new RebalancerService(config, pino({ level: "silent" }), stateStore, meteoraClient as never, {
    poolAddress: POOL,
    tokenAMint: SOL,
    tokenBMint: USDC,
    tokenADecimals: 9,
    tokenBDecimals: 6,
    binStep: 10,
    strategy: "Spot",
    allocationUsdc: 100,
    resolveAllocationQuoteBudget: resolveBudget
  });
  (service as unknown as { accountReader: unknown }).accountReader = { getWalletBalances: async () => balances };

  return { service, openPosition, swap, getState: () => state };
}

describe("allocation cap that cannot be priced", () => {
  it.each(["opening", "swapping"] as const)("does not deploy in the %s phase and schedules a retry", async (phase) => {
    const { service, openPosition, swap, getState } = setup(phase, async () => null);

    await service.runCycle("run");

    const state = getState();
    expect(openPosition).not.toHaveBeenCalled();
    expect(swap).not.toHaveBeenCalled();
    expect(state.paused).toBe(false);
    expect(state.pendingRebalance?.phase).toBe(phase);
    expect(state.pendingRebalance?.nextRetryAt).not.toBeNull();
    expect(state.pendingRebalance?.recoveryReason).toMatch(/Allocation cap could not be priced/);
    expect(state.latestAction).toMatch(/allocation cap could not be priced/);
  });

  it("caps the open to the budget when the price is available", async () => {
    const { service, openPosition } = setup("opening", async () => 100);

    await service.runCycle("run");

    expect(openPosition).toHaveBeenCalledTimes(1);
    const params = openPosition.mock.calls[0] as unknown as [{ tokenAAmount: bigint; tokenBAmount: bigint }];
    const { tokenAAmount, tokenBAmount } = params[0];
    // $100 budget out of ~$2000: about 0.5 SOL and 50 USDC (before the SOL rent reserve).
    expect(Number(tokenAAmount) / 1e9 * 100 + Number(tokenBAmount) / 1e6).toBeLessThanOrEqual(100);
    expect(Number(tokenBAmount)).toBeCloseTo(50_000_000, -3);
  });
});
