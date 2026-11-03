import { loadConfig } from "../src/config.js";
import { MeteoraClient } from "../src/clients/meteoraClient.js";
import { createLogger } from "../src/logger.js";

// Usage: npx tsx scripts/list-positions.ts   (pool from POOL_ADDRESS)
const config = loadConfig();
const pool = config.POOL_ADDRESS;
if (!pool) {
  console.error("POOL_ADDRESS is not set. Set it in .env or the environment.");
  process.exit(1);
}

const client = new MeteoraClient(config, createLogger(config));
await client.init();

const dlmm = await (client as any).createDlmmInstance(pool);
const wallet = (client as any).wallet;
const { userPositions } = await dlmm.getPositionsByUserAndLbPair(wallet.publicKey);

for (const p of (userPositions ?? [])) {
  const addr = p.publicKey.toBase58();
  const totalX = p.positionData.totalXAmount?.toString() ?? "0";
  const totalY = p.positionData.totalYAmount?.toString() ?? "0";
  const bins = (p.positionData.positionBinData ?? []);
  const nonEmpty = bins.filter((b: any) => b.binXAmount !== "0" || b.binYAmount !== "0");
  console.log(`${addr}:`);
  console.log(`  totalX=${totalX} totalY=${totalY}`);
  console.log(`  bins=${bins.length} nonEmpty=${nonEmpty.length}`);
  if (nonEmpty.length > 0) {
    console.log(`  first nonEmpty: binId=${nonEmpty[0].binId} X=${nonEmpty[0].binXAmount} Y=${nonEmpty[0].binYAmount}`);
  }
}
