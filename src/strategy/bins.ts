import type { StrategyType } from "../config.js";
import type { DriftDirection } from "../domain.js";

export interface BinRange {
  lowerBinId: number;
  upperBinId: number;
}

export interface PriceBand {
  lower: number;
  upper: number;
}

export interface DriftEvaluation {
  direction: DriftDirection | null;
  shouldRebalance: boolean;
}

/**
 * Convert a human-readable price to a DLMM bin ID.
 * DLMM bin price formula: rawPrice(binId) = (1 + binStep/10000)^binId
 * Human-readable price = rawPrice * 10^(tokenADecimals - tokenBDecimals)
 *
 * @param price Human-readable price (e.g. 88 USDC per SOL)
 * @param binStep Pool bin step
 * @param decimalAdjust tokenADecimals - tokenBDecimals (e.g. 9-6=3 for SOL/USDC). Default 0.
 */
export function priceToBinId(price: number, binStep: number, decimalAdjust = 0): number {
  const rawPrice = decimalAdjust !== 0 ? price / Math.pow(10, decimalAdjust) : price;
  if (rawPrice <= 0 || binStep <= 0) {
    return 0;
  }

  return Math.floor(Math.log(rawPrice) / Math.log(1 + binStep / 10_000));
}

/**
 * Convert a DLMM bin ID back to a human-readable price.
 *
 * @param binId The bin ID
 * @param binStep Pool bin step
 * @param decimalAdjust tokenADecimals - tokenBDecimals (e.g. 9-6=3 for SOL/USDC). Default 0.
 */
export function binIdToPrice(binId: number, binStep: number, decimalAdjust = 0): number {
  const rawPrice = Math.pow(1 + binStep / 10_000, binId);
  return decimalAdjust !== 0 ? rawPrice * Math.pow(10, decimalAdjust) : rawPrice;
}

/**
 * Compute the bin range from min/max human-readable price for a given pool's binStep.
 */
export function computeBinRange(minPrice: number, maxPrice: number, binStep: number, decimalAdjust = 0): BinRange {
  return {
    lowerBinId: priceToBinId(minPrice, binStep, decimalAdjust),
    upperBinId: priceToBinId(maxPrice, binStep, decimalAdjust)
  };
}

/**
 * Compute a human-readable price band from bin range boundaries.
 */
export function computePriceBand(lowerBinId: number, upperBinId: number, binStep: number, decimalAdjust = 0): PriceBand {
  return {
    lower: binIdToPrice(lowerBinId, binStep, decimalAdjust),
    upper: binIdToPrice(upperBinId, binStep, decimalAdjust)
  };
}

/**
 * Compute a centered bin range around a current price, preserving the same width (number of bins).
 */
export function computeCenteredBinRange(
  centerPrice: number,
  halfWidthBins: number,
  binStep: number,
  decimalAdjust = 0
): BinRange {
  const centerBinId = priceToBinId(centerPrice, binStep, decimalAdjust);
  return {
    lowerBinId: centerBinId - halfWidthBins,
    upperBinId: centerBinId + halfWidthBins
  };
}

/**
 * Evaluate whether the current price has drifted outside the bot's configured range.
 * Unlike Orca which uses % drift from center, DLMM bots use absolute min/max price boundaries.
 */
export function evaluateDriftTrigger(
  currentPrice: number,
  minPrice: number,
  maxPrice: number
): DriftEvaluation {
  if (currentPrice <= minPrice) {
    return { direction: "below", shouldRebalance: true };
  }

  if (currentPrice >= maxPrice) {
    return { direction: "above", shouldRebalance: true };
  }

  return { direction: null, shouldRebalance: false };
}

/**
 * Evaluate whether the pool's active bin has left the position's bin range.
 * This is the most reliable out-of-range check for DLMM since it uses
 * integer bin IDs with no floating-point ambiguity.
 */
export function evaluateBinDriftTrigger(
  activeBinId: number,
  positionLowerBinId: number,
  positionUpperBinId: number
): DriftEvaluation {
  if (activeBinId < positionLowerBinId) {
    return { direction: "below", shouldRebalance: true };
  }

  if (activeBinId > positionUpperBinId) {
    return { direction: "above", shouldRebalance: true };
  }

  return { direction: null, shouldRebalance: false };
}

/**
 * Compute target value weights for token A and B based on DLMM position.
 *
 * For Spot strategy (uniform distribution), the weight calculation is similar to
 * concentrated liquidity: based on where the current price sits within the range.
 *
 * For Curve/BidAsk, different distributions apply but the overall token ratio
 * still depends on price position relative to range boundaries.
 */
export function computeTargetValueWeights(
  lowerPrice: number,
  currentPrice: number,
  upperPrice: number,
  strategy: StrategyType = "Spot"
): { tokenA: number; tokenB: number } {
  if (currentPrice <= lowerPrice) {
    // All bins above current price → all hold token A (SOL)
    return { tokenA: 1, tokenB: 0 };
  }

  if (currentPrice >= upperPrice) {
    // All bins below current price → all hold token B (USDC)
    return { tokenA: 0, tokenB: 1 };
  }

  if (strategy === "Spot") {
    // Uniform DLMM distribution: each bin holds equal dollar value.
    // Bins above current price hold token A (SOL); bins below hold token B (USDC).
    // Value weight = fraction of bins on each side.
    const range = upperPrice - lowerPrice;
    return {
      tokenA: (upperPrice - currentPrice) / range,
      tokenB: (currentPrice - lowerPrice) / range
    };
  }

  if (strategy === "Curve") {
    // Gaussian-like: more liquidity near center, use sqrt-based formula
    const sqrtLower = Math.sqrt(lowerPrice);
    const sqrtCurrent = Math.sqrt(currentPrice);
    const sqrtUpper = Math.sqrt(upperPrice);
    const amountA = (sqrtUpper - sqrtCurrent) / (sqrtCurrent * sqrtUpper);
    const amountB = sqrtCurrent - sqrtLower;
    const valueA = amountA * currentPrice;
    const valueB = amountB;
    const total = valueA + valueB;
    return {
      tokenA: valueA / total,
      tokenB: valueB / total
    };
  }

  // BidAsk: more liquidity at edges, approximated with linear weighting
  const midPrice = (lowerPrice + upperPrice) / 2;
  if (currentPrice < midPrice) {
    // More token B needed (bid side)
    const ratio = (midPrice - currentPrice) / (midPrice - lowerPrice);
    const tokenBWeight = 0.5 + ratio * 0.3;
    return { tokenA: 1 - tokenBWeight, tokenB: tokenBWeight };
  }

  // More token A needed (ask side)
  const ratio = (currentPrice - midPrice) / (upperPrice - midPrice);
  const tokenAWeight = 0.5 + ratio * 0.3;
  return { tokenA: tokenAWeight, tokenB: 1 - tokenAWeight };
}

/**
 * Proactive drift: trigger rebalance when price reaches a configurable
 * percentage of the distance from range center to range edge.
 *
 * @param currentPrice Current market price
 * @param lowerPrice  Position's lower price boundary
 * @param upperPrice  Position's upper price boundary
 * @param thresholdPct Fraction of half-range (0-1). 0.80 = rebalance at 80% of distance to edge.
 */
export function evaluateProactiveDriftTrigger(
  currentPrice: number,
  lowerPrice: number,
  upperPrice: number,
  thresholdPct: number
): DriftEvaluation {
  if (thresholdPct <= 0 || thresholdPct > 1) {
    return { direction: null, shouldRebalance: false };
  }

  const center = (upperPrice + lowerPrice) / 2;
  const halfRange = (upperPrice - lowerPrice) / 2;
  const threshold = halfRange * thresholdPct;

  if (currentPrice <= center - threshold) {
    return { direction: "below", shouldRebalance: true };
  }

  if (currentPrice >= center + threshold) {
    return { direction: "above", shouldRebalance: true };
  }

  return { direction: null, shouldRebalance: false };
}

export function toBaseUnits(amount: number, decimals: number): bigint {
  return BigInt(Math.floor(amount * 10 ** decimals));
}

export function fromBaseUnits(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}
