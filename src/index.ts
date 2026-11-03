import { dirname, join } from "node:path";

import { PublicKey } from "@solana/web3.js";

import { loadConfig } from "./config.js";
import { MeteoraClient } from "./clients/meteoraClient.js";
import { createLogger } from "./logger.js";
import { resolveTokenPricesUsdcStrict, SOL_MINT } from "./services/pnlMath.js";
import { RebalancerService, type RunMode } from "./services/rebalancer.js";
import { StateStore } from "./state/store.js";

const USAGE = "Usage: tsx src/index.ts <run|dry-run|rebalance-now> [poolAddress]";

function resolvePoolAddress(cliPool: string | undefined, envPool: string): string {
  const poolAddress = (cliPool ?? envPool).trim();
  if (!poolAddress) {
    throw new Error(`No pool address configured. Set POOL_ADDRESS in .env or pass it as an argument.\n${USAGE}`);
  }
  try {
    new PublicKey(poolAddress);
  } catch {
    throw new Error(`Invalid pool address "${poolAddress}": not a valid Solana public key.`);
  }
  return poolAddress;
}

/**
 * USD value of one quote token (token B), used to turn CLI_ALLOCATION_USDC into a quote-token budget.
 * USDC pairs are priced directly from the pool; SOL pairs use a live SOL/USDC quote, falling back
 * to the last good quote so a transient price failure never lifts the cap.
 */
function createQuoteTokenUsdPricer(
  meteoraClient: MeteoraClient,
  pool: { tokenAMint: string; tokenBMint: string }
): ((currentPrice: number) => Promise<number | null>) | null {
  if (resolveTokenPricesUsdcStrict(pool, 1, [])) {
    return async (currentPrice) => resolveTokenPricesUsdcStrict(pool, currentPrice, [])?.tokenBUsdc ?? null;
  }
  if (pool.tokenAMint !== SOL_MINT && pool.tokenBMint !== SOL_MINT) {
    return null;
  }

  let lastSolUsdc: number | null = null;
  return async (currentPrice) => {
    const solUsdc = await meteoraClient.getSolUsdcPrice();
    if (solUsdc && Number.isFinite(solUsdc) && solUsdc > 0) lastSolUsdc = solUsdc;
    if (!lastSolUsdc) return null;
    return pool.tokenAMint === SOL_MINT ? lastSolUsdc / currentPrice : lastSolUsdc;
  };
}

async function main() {
  const [modeArg, poolArg] = process.argv.slice(2);
  if (!modeArg || !["run", "dry-run", "rebalance-now"].includes(modeArg)) {
    throw new Error(USAGE);
  }

  const mode = modeArg as RunMode;
  const config = loadConfig();
  const poolAddress = resolvePoolAddress(poolArg, config.POOL_ADDRESS);
  const logger = createLogger(config);
  const stateStore = new StateStore(join(dirname(config.BOT_REGISTRY_FILE), "state.json"));
  const meteoraClient = new MeteoraClient(config, logger);

  await meteoraClient.init();

  // Token mints, decimals and bin step are read from the pool, as the control panel does.
  const pool = await meteoraClient.fetchPoolSnapshot(poolAddress);

  // Optional allocation cap, applied the same way as a control-panel bot's allocationUsdc.
  const allocationUsdc = config.CLI_ALLOCATION_USDC;
  let resolveAllocationQuoteBudget: ((currentPrice: number) => Promise<number | null>) | undefined;
  if (allocationUsdc > 0) {
    const quoteTokenUsd = createQuoteTokenUsdPricer(meteoraClient, pool);
    if (!quoteTokenUsd) {
      throw new Error(
        "CLI_ALLOCATION_USDC is set, but this pool has neither USDC nor SOL as a token, so its USD value cannot be priced. " +
          "Unset CLI_ALLOCATION_USDC or use the control panel."
      );
    }
    // Fail fast rather than deploy uncapped if the price cannot be resolved at startup.
    if (!(await quoteTokenUsd(pool.currentPrice))) {
      throw new Error("CLI_ALLOCATION_USDC is set, but the quote token's USD price could not be fetched. Try again later.");
    }
    resolveAllocationQuoteBudget = async (currentPrice) => {
      const price = await quoteTokenUsd(currentPrice);
      return price ? allocationUsdc / price : null;
    };
    logger.info({ allocationUsdc }, "CLI allocation cap enabled");
  } else {
    logger.warn("CLI_ALLOCATION_USDC is not set: the CLI deploys the wallet's whole balance of the pool's tokens");
  }

  const service = new RebalancerService(config, logger, stateStore, meteoraClient, {
    poolAddress,
    tokenAMint: pool.tokenAMint,
    tokenBMint: pool.tokenBMint,
    tokenADecimals: pool.tokenADecimals,
    tokenBDecimals: pool.tokenBDecimals,
    binStep: pool.binStep,
    strategy: config.DEFAULT_STRATEGY,
    allocationUsdc: allocationUsdc > 0 ? allocationUsdc : undefined,
    resolveAllocationQuoteBudget
  });
  await service.run(mode);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
