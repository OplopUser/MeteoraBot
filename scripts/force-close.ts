import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { MeteoraClient } from "../src/clients/meteoraClient.js";
import { createLogger } from "../src/logger.js";

const config = loadConfig();
const logger = createLogger(config);
const client = new MeteoraClient(config, logger);
await (client as any).init();

const pool = "BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y";

// Close only the orphaned position, skip the active bot position
const ACTIVE_POSITION = process.env.ACTIVE_POSITION ?? "";
const dlmm = await (client as any).createDlmmInstance(pool);
const wallet = (client as any).wallet;
const { userPositions } = await dlmm.getPositionsByUserAndLbPair(wallet.publicKey);

console.log(`Found ${(userPositions ?? []).length} positions total.\n`);

for (const p of (userPositions ?? [])) {
  const addr = p.publicKey.toBase58();
  if (addr === ACTIVE_POSITION) {
    console.log(`Skipping active position ${addr}\n`);
    continue;
  }
  console.log(`Closing orphaned position ${addr}...`);
  try {
    const result = await client.closePosition(pool, addr, 1000);
    console.log(`  withdrawnTokenA: ${result.withdrawnTokenA}`);
    console.log(`  withdrawnTokenB: ${result.withdrawnTokenB}`);
    console.log(`  txIds: ${result.txIds.join(", ")}`);
    console.log(`  Done!\n`);
  } catch (e) {
    console.error(`  Failed: ${(e as Error).message}\n`);
  }
}

console.log("All positions closed.");
