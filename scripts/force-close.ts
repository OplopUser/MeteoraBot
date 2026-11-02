import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { MeteoraClient } from "../src/clients/meteoraClient.js";
import { createLogger } from "../src/logger.js";

// Usage: ACTIVE_POSITION=<position-to-keep> npx tsx scripts/force-close.ts
//        npx tsx scripts/force-close.ts --all   (closes EVERY position in the pool)
const closeAll = process.argv.slice(2).includes("--all");
const ACTIVE_POSITION = (process.env.ACTIVE_POSITION ?? "").trim();

if (!ACTIVE_POSITION && !closeAll) {
  console.error(
    "Refusing to run: ACTIVE_POSITION is not set, so every position in the pool would be closed.\n" +
      "Set ACTIVE_POSITION=<position-to-keep>, or pass --all to close every position."
  );
  process.exit(1);
}

const config = loadConfig();
const pool = config.POOL_ADDRESS;
if (!pool) {
  console.error("Refusing to run: POOL_ADDRESS is not set. Set it in .env or the environment.");
  process.exit(1);
}

const logger = createLogger(config);
const client = new MeteoraClient(config, logger);
await (client as any).init();

// Close only the orphaned positions, skip the active bot position
const dlmm = await (client as any).createDlmmInstance(pool);
const wallet = (client as any).wallet;
const { userPositions } = await dlmm.getPositionsByUserAndLbPair(wallet.publicKey);

console.log(`Found ${(userPositions ?? []).length} positions total.\n`);

if (ACTIVE_POSITION && !(userPositions ?? []).some((p: any) => p.publicKey.toBase58() === ACTIVE_POSITION)) {
  console.error(`Refusing to run: ACTIVE_POSITION ${ACTIVE_POSITION} is not a wallet position in pool ${pool}.`);
  process.exit(1);
}

let failures = 0;
for (const p of (userPositions ?? [])) {
  const addr = p.publicKey.toBase58();
  if (addr === ACTIVE_POSITION) {
    console.log(`Skipping active position ${addr}\n`);
    continue;
  }
  console.log(`Closing orphaned position ${addr}...`);
  try {
    const result = await client.closePosition(pool, addr, true);
    console.log(`  withdrawnTokenA: ${result.withdrawnTokenA}`);
    console.log(`  withdrawnTokenB: ${result.withdrawnTokenB}`);
    console.log(`  txIds: ${result.txIds.join(", ")}`);
    console.log(`  Done!\n`);
  } catch (e) {
    console.error(`  Failed: ${(e as Error).message}\n`);
    failures++;
  }
}

if (failures > 0) {
  console.error(`${failures} position(s) failed to close.`);
  process.exit(1);
}
console.log("All orphaned positions closed.");
