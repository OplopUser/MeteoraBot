import type { AppConfig } from "./config.js";
import type { BotDefinition } from "./domain.js";

export function buildBotConfig(baseConfig: AppConfig, bot: BotDefinition): AppConfig {
  return {
    ...baseConfig,
    POLL_SECONDS: bot.pollSeconds,
    MAX_SLIPPAGE_BPS: bot.maxSlippageBps,
    CLOSE_RETRY_SLIPPAGE_BPS: bot.closeRetrySlippageBps,
    CLOSE_FINAL_RETRY_SLIPPAGE_BPS: bot.closeFinalRetrySlippageBps,
    OPEN_RETRY_SLIPPAGE_BPS: bot.openRetrySlippageBps,
    OPEN_FINAL_RETRY_SLIPPAGE_BPS: bot.openFinalRetrySlippageBps,
    SLIPPAGE_RETRIES_PER_TIER: bot.slippageRetriesPerTier,
    OPEN_DEPLOYMENT_BUFFER_BPS: bot.openDeploymentBufferBps,
    OPEN_RETRY_DEPLOYMENT_BUFFER_BPS: bot.openRetryDeploymentBufferBps,
    OPEN_FINAL_DEPLOYMENT_BUFFER_BPS: bot.openFinalDeploymentBufferBps,
    MIN_SWAP_USDC: bot.minSwapQuoteValue,
    OPEN_BALANCE_TOLERANCE_BPS: bot.openBalanceToleranceBps,
    maxSlippageFraction: bot.maxSlippageBps / 10_000
  };
}
