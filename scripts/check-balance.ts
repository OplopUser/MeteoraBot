import { loadConfig } from "../src/config.js";
import { MeteoraClient } from "../src/clients/meteoraClient.js";
import { createLogger } from "../src/logger.js";

const config = loadConfig();
const client = new MeteoraClient(config, createLogger(config));
await client.init();

const positions = await client.listAllOwnerPositions();
console.log("Remaining positions:", positions.length);

const balances = await client.getWalletBalances(
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);
const sol = Number(balances.tokenA) / 1e9;
const usdc = Number(balances.tokenB) / 1e6;
// Live SOL/USDC quote from Jupiter, the same source the control panel falls back to.
const solPrice = await client.getSolUsdcPrice();
if (solPrice) {
  console.log(`SOL:  ${sol.toFixed(4)} (~$${(sol * solPrice).toFixed(2)} at $${solPrice.toFixed(2)})`);
  console.log(`USDC: ${usdc.toFixed(4)}`);
  console.log(`Total: ~$${(sol * solPrice + usdc).toFixed(2)}`);
} else {
  console.log(`SOL:  ${sol.toFixed(4)} (USD price unavailable)`);
  console.log(`USDC: ${usdc.toFixed(4)}`);
}
