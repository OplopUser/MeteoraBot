import { describe, it, expect } from "vitest";
import {
  priceToBinId,
  binIdToPrice,
  computeBinRange,
  computeCenteredBinRange,
  computePriceBand,
  evaluateDriftTrigger,
  evaluateBinDriftTrigger,
  computeTargetValueWeights,
  toBaseUnits,
  fromBaseUnits
} from "../src/strategy/bins.js";

describe("priceToBinId", () => {
  it("returns 0 for price <= 0", () => {
    expect(priceToBinId(0, 10)).toBe(0);
    expect(priceToBinId(-1, 10)).toBe(0);
  });

  it("returns 0 for binStep <= 0", () => {
    expect(priceToBinId(100, 0)).toBe(0);
  });

  it("computes correct bin id for known values", () => {
    // binStep = 1 means each bin is 0.01% apart
    // price = (1 + 1/10000)^binId = 1.0001^binId
    // For price = 1, binId = 0
    expect(priceToBinId(1, 1)).toBe(0);

    // For binStep = 100 (1% per bin), price = 2 → binId = floor(ln(2) / ln(1.01)) ≈ 69
    const binId = priceToBinId(2, 100);
    expect(binId).toBe(69);
  });

  it("floors the result", () => {
    const binStep = 10; // 0.1% per bin
    const price = 1.005; // slightly above bin boundary
    const binId = priceToBinId(price, binStep);
    expect(binId).toBe(Math.floor(Math.log(price) / Math.log(1 + binStep / 10_000)));
  });
});

describe("binIdToPrice", () => {
  it("returns 1 for binId = 0", () => {
    expect(binIdToPrice(0, 10)).toBe(1);
  });

  it("round-trips with priceToBinId", () => {
    const binStep = 10;
    const originalPrice = 150;
    const binId = priceToBinId(originalPrice, binStep);
    const recoveredPrice = binIdToPrice(binId, binStep);
    // Should be close but not exact due to flooring
    expect(recoveredPrice).toBeLessThanOrEqual(originalPrice);
    expect(recoveredPrice).toBeGreaterThan(originalPrice * 0.999);
  });
});

describe("computeBinRange", () => {
  it("computes lower and upper bin ids from price range", () => {
    const range = computeBinRange(100, 200, 10);
    expect(range.lowerBinId).toBeLessThan(range.upperBinId);
    expect(binIdToPrice(range.lowerBinId, 10)).toBeLessThanOrEqual(100);
    expect(binIdToPrice(range.upperBinId, 10)).toBeLessThanOrEqual(200);
  });
});

describe("computePriceBand", () => {
  it("converts bin range back to prices", () => {
    const binStep = 10;
    const range = computeBinRange(100, 200, binStep);
    const band = computePriceBand(range.lowerBinId, range.upperBinId, binStep);
    expect(band.lower).toBeGreaterThan(0);
    expect(band.upper).toBeGreaterThan(band.lower);
  });
});

describe("computeCenteredBinRange", () => {
  it("centers around the given price", () => {
    const range = computeCenteredBinRange(150, 50, 10);
    const centerBin = priceToBinId(150, 10);
    expect(range.lowerBinId).toBe(centerBin - 50);
    expect(range.upperBinId).toBe(centerBin + 50);
  });
});

describe("evaluateDriftTrigger", () => {
  it("returns no rebalance when price is within range", () => {
    const result = evaluateDriftTrigger(150, 100, 200);
    expect(result.shouldRebalance).toBe(false);
    expect(result.direction).toBeNull();
  });

  it("triggers below when price drops below min", () => {
    const result = evaluateDriftTrigger(90, 100, 200);
    expect(result.shouldRebalance).toBe(true);
    expect(result.direction).toBe("below");
  });

  it("triggers above when price exceeds max", () => {
    const result = evaluateDriftTrigger(210, 100, 200);
    expect(result.shouldRebalance).toBe(true);
    expect(result.direction).toBe("above");
  });

  it("boundary: price exactly at min triggers rebalance", () => {
    const result = evaluateDriftTrigger(100, 100, 200);
    expect(result.shouldRebalance).toBe(true);
    expect(result.direction).toBe("below");
  });

  it("boundary: price exactly at max triggers rebalance", () => {
    const result = evaluateDriftTrigger(200, 100, 200);
    expect(result.shouldRebalance).toBe(true);
    expect(result.direction).toBe("above");
  });
});

describe("evaluateBinDriftTrigger", () => {
  it("returns no rebalance when active bin is within position range", () => {
    const result = evaluateBinDriftTrigger(50, 10, 100);
    expect(result.shouldRebalance).toBe(false);
    expect(result.direction).toBeNull();
  });

  it("triggers below when active bin drops below position lower bin", () => {
    const result = evaluateBinDriftTrigger(5, 10, 100);
    expect(result.shouldRebalance).toBe(true);
    expect(result.direction).toBe("below");
  });

  it("triggers above when active bin exceeds position upper bin", () => {
    const result = evaluateBinDriftTrigger(105, 10, 100);
    expect(result.shouldRebalance).toBe(true);
    expect(result.direction).toBe("above");
  });

  it("boundary: active bin exactly at lower is within range", () => {
    const result = evaluateBinDriftTrigger(10, 10, 100);
    expect(result.shouldRebalance).toBe(false);
  });

  it("boundary: active bin exactly at upper is within range", () => {
    const result = evaluateBinDriftTrigger(100, 10, 100);
    expect(result.shouldRebalance).toBe(false);
  });

  it("works with negative bin IDs", () => {
    const result = evaluateBinDriftTrigger(-2450, -2511, -2451);
    expect(result.shouldRebalance).toBe(true);
    expect(result.direction).toBe("above");
  });

  it("negative bin IDs within range", () => {
    const result = evaluateBinDriftTrigger(-2480, -2511, -2451);
    expect(result.shouldRebalance).toBe(false);
  });
});

describe("computeTargetValueWeights", () => {
  it("returns 100% tokenA when price at or below lower bound", () => {
    // Price below range → all bins above current price → all hold token A
    const weights = computeTargetValueWeights(100, 90, 200);
    expect(weights.tokenA).toBe(1);
    expect(weights.tokenB).toBe(0);
  });

  it("returns 100% tokenB when price at or above upper bound", () => {
    // Price above range → all bins below current price → all hold token B
    const weights = computeTargetValueWeights(100, 210, 200);
    expect(weights.tokenA).toBe(0);
    expect(weights.tokenB).toBe(1);
  });

  it("returns balanced weights at midpoint for Spot strategy", () => {
    const weights = computeTargetValueWeights(100, 150, 200, "Spot");
    expect(weights.tokenA).toBeGreaterThan(0);
    expect(weights.tokenB).toBeGreaterThan(0);
    expect(weights.tokenA + weights.tokenB).toBeCloseTo(1);
  });

  it("Curve strategy returns balanced weights", () => {
    const weights = computeTargetValueWeights(100, 150, 200, "Curve");
    expect(weights.tokenA).toBeGreaterThan(0);
    expect(weights.tokenB).toBeGreaterThan(0);
    expect(weights.tokenA + weights.tokenB).toBeCloseTo(1);
  });

  it("BidAsk strategy returns balanced weights", () => {
    const weights = computeTargetValueWeights(100, 150, 200, "BidAsk");
    expect(weights.tokenA).toBeGreaterThan(0);
    expect(weights.tokenB).toBeGreaterThan(0);
    expect(weights.tokenA + weights.tokenB).toBeCloseTo(1);
  });
});

describe("toBaseUnits / fromBaseUnits", () => {
  it("converts to and from base units", () => {
    const amount = 1.5;
    const decimals = 9;
    const base = toBaseUnits(amount, decimals);
    expect(base).toBe(1_500_000_000n);
    expect(fromBaseUnits(base, decimals)).toBeCloseTo(amount);
  });

  it("handles 6 decimal tokens (USDC)", () => {
    const base = toBaseUnits(100.25, 6);
    expect(base).toBe(100_250_000n);
    expect(fromBaseUnits(base, 6)).toBeCloseTo(100.25);
  });
});
