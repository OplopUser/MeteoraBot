import { loadConfig } from "./config.js";
import { MeteoraClient } from "./clients/meteoraClient.js";
import { createLogger } from "./logger.js";
import { RebalancerService, type RunMode } from "./services/rebalancer.js";
import { StateStore } from "./state/store.js";

async function main() {
  const modeArg = process.argv[2];
  if (!modeArg || !["run", "dry-run", "rebalance-now"].includes(modeArg)) {
    throw new Error("Usage: tsx src/index.ts <run|dry-run|rebalance-now>");
  }

  const mode = modeArg as RunMode;
  const config = loadConfig();
  const logger = createLogger(config);
  const stateStore = new StateStore(config.BOT_REGISTRY_FILE.replace("bots.json", "state.json"));
  const meteoraClient = new MeteoraClient(config, logger);

  await meteoraClient.init();

  const service = new RebalancerService(config, logger, stateStore, meteoraClient);
  await service.run(mode);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
