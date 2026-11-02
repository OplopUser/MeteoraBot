import { dirname, join } from "node:path";

import { PublicKey } from "@solana/web3.js";

import { loadConfig } from "./config.js";
import { MeteoraClient } from "./clients/meteoraClient.js";
import { createLogger } from "./logger.js";
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

  const service = new RebalancerService(config, logger, stateStore, meteoraClient, {
    poolAddress,
    tokenAMint: pool.tokenAMint,
    tokenBMint: pool.tokenBMint,
    tokenADecimals: pool.tokenADecimals,
    tokenBDecimals: pool.tokenBDecimals,
    binStep: pool.binStep,
    strategy: config.DEFAULT_STRATEGY
  });
  await service.run(mode);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
