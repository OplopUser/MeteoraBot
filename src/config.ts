import dotenv from "dotenv";
import { z } from "zod";

import { normalizeRpcUrls } from "./infra/rpcFailover.js";

dotenv.config({ override: true });

const strategyEnum = z.enum(["Spot", "Curve", "BidAsk"]);

const envSchema = z.object({
  SOLANA_RPC_URL: z.string().url(),
  SOLANA_RPC_FALLBACK_URLS: z.string().default(""),
  BOT_WALLET_KEYPAIR_PATH: z.string().min(1),
  BOT_REGISTRY_FILE: z.string().default("./data/bots.json"),
  BOT_PNL_LEDGER_FILE: z.string().default("./data/pnl-ledger.json"),
  LOG_FILE: z.string().default("./data/logs/rebalancer.log"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  JUPITER_API_BASE_URL: z.string().url().default("https://lite-api.jup.ag/swap/v1"),
  JUPITER_API_KEY: z.string().default(""),
  DEFAULT_STRATEGY: strategyEnum.default("Spot"),
  POLL_SECONDS: z.coerce.number().int().positive().default(15),
  MAX_SLIPPAGE_BPS: z.coerce.number().int().positive().default(100),
  CLOSE_RETRY_SLIPPAGE_BPS: z.coerce.number().int().positive().default(300),
  CLOSE_FINAL_RETRY_SLIPPAGE_BPS: z.coerce.number().int().positive().default(1000),
  OPEN_RETRY_SLIPPAGE_BPS: z.coerce.number().int().positive().default(300),
  OPEN_FINAL_RETRY_SLIPPAGE_BPS: z.coerce.number().int().positive().default(1000),
  SLIPPAGE_RETRIES_PER_TIER: z.coerce.number().int().positive().default(3),
  OPEN_DEPLOYMENT_BUFFER_BPS: z.coerce.number().int().min(0).max(9_999).default(100),
  OPEN_RETRY_DEPLOYMENT_BUFFER_BPS: z.coerce.number().int().min(0).max(9_999).default(300),
  OPEN_FINAL_DEPLOYMENT_BUFFER_BPS: z.coerce.number().int().min(0).max(9_999).default(500),
  SOL_RESERVE_LAMPORTS: z.coerce.number().int().nonnegative().default(50_000_000),
  MIN_SWAP_USDC: z.coerce.number().nonnegative().default(10),
  OPEN_BALANCE_TOLERANCE_BPS: z.coerce.number().int().min(0).max(10_000).default(25)
});

export type StrategyType = z.infer<typeof strategyEnum>;

export type AppConfig = z.infer<typeof envSchema> & {
  maxSlippageFraction: number;
  solanaRpcUrls: string[];
};

export function loadConfig(): AppConfig {
  const parsed = envSchema.parse(process.env);

  return {
    ...parsed,
    maxSlippageFraction: parsed.MAX_SLIPPAGE_BPS / 10_000,
    solanaRpcUrls: normalizeRpcUrls(
      parsed.SOLANA_RPC_URL,
      parsed.SOLANA_RPC_FALLBACK_URLS
    )
  };
}
