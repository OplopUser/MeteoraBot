import type { StrategyType } from "./config.js";

export type DriftDirection = "below" | "above";
export type DriftStatus = "waiting" | "triggered";
export type RebalancePhase = "closing" | "swapping" | "opening";
export type BotId = string;
export type PositionPnlStatus = "open" | "closed";

export interface PendingRebalance {
  phase: RebalancePhase;
  startedAt: string;
  nextRetryAt: string | null;
  anchorPrice: number;
  targetCenterPrice: number;
  previousPositionAddress: string | null;
  plannedPositionAddress: string | null;
  lastKnownCloseTxId: string | null;
  lastKnownSwapTxId: string | null;
  lastKnownOpenTxId: string | null;
  recoveryReason: string | null;
  retryCount: number;
  openFailureCount: number;
  entryCapitalQuote: number | null;
  entryTokenA: string | null;
  entryTokenB: string | null;
  cumulativeSwapFeeQuote: number;
  cumulativeTxFeeLamports: number;
}

export interface BotState {
  activePositionAddress: string | null;
  activeLowerBinId: number | null;
  activeUpperBinId: number | null;
  lastRebalanceAt: string | null;
  lastCenterPrice: number | null;
  latestAction: string | null;
  lastPnlMarkAt: string | null;
  paused: boolean;
  pauseReason: string | null;
  inFlightRebalance: boolean;
  lastObservedPrice: number | null;
  driftDirection: DriftDirection | null;
  driftStatus: DriftStatus | null;
  pendingRebalance: PendingRebalance | null;
  positionLowerPrice: number | null;
  positionUpperPrice: number | null;
}

export interface BotRuntimeState extends BotState {
  monitoringActive: boolean;
  lastCycleAt: string | null;
}

export interface BotDefinition {
  id: BotId;
  name: string;
  enabled: boolean;
  archived: boolean;
  dlmmPoolAddress: string;
  minPrice: number;
  maxPrice: number;
  strategy: StrategyType;
  binStep: number;
  allocationUsdc: number;
  pollSeconds: number;
  maxSlippageBps: number;
  closeRetrySlippageBps: number;
  closeFinalRetrySlippageBps: number;
  openRetrySlippageBps: number;
  openFinalRetrySlippageBps: number;
  slippageRetriesPerTier: number;
  openDeploymentBufferBps: number;
  openRetryDeploymentBufferBps: number;
  openFinalDeploymentBufferBps: number;
  minSwapQuoteValue: number;
  openBalanceToleranceBps: number;
  autoCompound: boolean;
  compoundMinValueUsdc: number;
  driftThresholdPct: number;
  rangeBins: number | null;
  trendShiftBins: number;
  tokenAMint: string;
  tokenASymbol: string;
  tokenADecimals: number;
  tokenBMint: string;
  tokenBSymbol: string;
  tokenBDecimals: number;
  createdAt: string;
  updatedAt: string;
}

export interface BotRecord {
  definition: BotDefinition;
  runtime: BotRuntimeState;
}

export interface BotRegistry {
  version: 1;
  bots: BotRecord[];
}

export interface WalletAllocationSummary {
  walletAddress: string | null;
  enabledBots: number;
  monitoringBots: number;
  totalAllocatedUsdc: number;
  availableTokenA: string | null;
  availableTokenB: string | null;
  queueDepth: number;
  overAllocated: boolean;
}

export interface ExecutionQueueJob {
  id: string;
  botId: BotId;
  reason: "trigger" | "manual" | "recovery";
  enqueuedAt: string;
}

export interface PoolMetadata {
  dlmmPoolAddress: string;
  binStep: number;
  tokenAMint: string;
  tokenASymbol: string;
  tokenADecimals: number;
  tokenBMint: string;
  tokenBSymbol: string;
  tokenBDecimals: number;
}

export interface PoolSnapshot {
  dlmmPoolAddress: string;
  currentPrice: number;
  activeBinId: number;
  binStep: number;
  tokenAMint: string;
  tokenBMint: string;
  tokenADecimals: number;
  tokenBDecimals: number;
}

export interface WalletBalances {
  tokenA: bigint;
  tokenB: bigint;
}

export interface ManagedPosition {
  positionAddress: string;
  dlmmPoolAddress: string;
  lowerBinId: number;
  upperBinId: number;
  liquidity: bigint;
  tokenAAmount: bigint;
  tokenBAmount: bigint;
  feeTokenA: bigint;
  feeTokenB: bigint;
}

export interface PositionLedgerOpenInput {
  botId: BotId;
  botName: string;
  dlmmPoolAddress: string;
  tokenPair: string;
  positionAddress: string;
  openedAt: string;
  centerPrice: number;
  lowerPrice: number | null;
  upperPrice: number | null;
  entryCapitalQuote: number;
  entryTokenA: string;
  entryTokenB: string;
  residualTokenA: string;
  residualTokenB: string;
  cumulativeSwapFeeQuote: number;
  cumulativeTxFeeLamports: number;
  openTxId: string | null;
  bootstrapped?: boolean;
}

export interface PositionLedgerCloseInput {
  botId: BotId;
  positionAddress: string;
  closedAt: string;
  centerPrice: number;
  exitGrossQuote: number;
  feesEarnedQuote: number;
  exitTokenA: string;
  exitTokenB: string;
  closeTxId: string | null;
  closeTxFeeLamports: number;
}

export interface PositionLedgerMarkInput {
  botId: BotId;
  positionAddress: string;
  markedAt: string;
  centerPrice: number;
  grossValueQuote: number;
  feesEarnedQuote: number;
  grossTokenA: string;
  grossTokenB: string;
}

export interface PositionPnlRecord {
  id: string;
  botId: BotId;
  botName: string;
  dlmmPoolAddress: string;
  tokenPair: string;
  positionAddress: string;
  status: PositionPnlStatus;
  openedAt: string;
  closedAt: string | null;
  entryCenterPrice: number;
  entryLowerPrice: number | null;
  entryUpperPrice: number | null;
  entryCapitalUsdc: number;
  entryTokenA: string;
  entryTokenB: string;
  residualTokenA: string;
  residualTokenB: string;
  cumulativeSwapFeesUsdc: number;
  cumulativeTxFeesUsdc: number;
  feesEarnedUsdc: number;
  latestGrossValueUsdc: number | null;
  latestNetPnlUsdc: number | null;
  lastMarkedAt: string | null;
  exitGrossValueUsdc: number | null;
  realizedNetPnlUsdc: number | null;
  openTxId: string | null;
  closeTxId: string | null;
  bootstrapped: boolean;
}

export interface PositionPnlLedger {
  version: 1;
  positions: PositionPnlRecord[];
}

export interface BotPnlSummary {
  botId: BotId;
  openNetPnlUsdc: number;
  realizedNetPnlUsdc: number;
  totalNetPnlUsdc: number;
  feesEarnedUsdc: number;
  openPositionCount: number;
  closedPositionCount: number;
}

export interface GlobalPnlSummary {
  totalNetPnlUsdc: number;
  realizedNetPnlUsdc: number;
  openNetPnlUsdc: number;
  feesEarnedUsdc: number;
  openPositionCount: number;
  closedPositionCount: number;
  orphanedPositionCount: number;
}

export class TransactionTimeoutError extends Error {
  constructor(
    public readonly phase: RebalancePhase,
    public readonly details: Record<string, string | null> = {}
  ) {
    super(`Transaction confirmation timeout during ${phase}`);
    this.name = "TransactionTimeoutError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
