import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createPanelAuth, isLoopbackHost } from "./panelAuth.js";
import { BotRegistryStore } from "./state/botRegistryStore.js";
import { BotSupervisor } from "./services/botSupervisor.js";
import { binIdToPrice, fromBaseUnits } from "./strategy/bins.js";

// Environment is loaded from .env by ./config.js.
const HOST = process.env.UI_HOST?.trim() || "127.0.0.1";
const PORT = Number(process.env.UI_PORT ?? 8789);
const UI_TOKEN = process.env.UI_TOKEN?.trim() ?? "";
const authenticate = createPanelAuth(UI_TOKEN);
const PUBLIC_DIR = resolve("public");

const config = loadConfig();
const logger = createLogger(config);
const registryStore = new BotRegistryStore(config.BOT_REGISTRY_FILE, config);
const supervisor = new BotSupervisor(config, logger, registryStore);

const STATUS_CACHE_TTL_MS = 5_000;
let statusCache: { json: string; cachedAt: number } | null = null;

function invalidateStatusCache() {
  statusCache = null;
}

interface TransactionEvent {
  botId: string | null;
  botName: string | null;
  time: string;
  type: string;
  status: string;
  txId: string | null;
  fees: string;
  summary: string;
}

interface BotPnlSummaryView {
  botId: string;
  openNetPnlUsdc: number;
  realizedNetPnlUsdc: number;
  totalNetPnlUsdc: number;
  feesEarnedUsdc: number;
  openPositionCount: number;
  closedPositionCount: number;
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendNoContent(response: ServerResponse) {
  response.writeHead(204);
  response.end();
}

function sendError(response: ServerResponse, statusCode: number, error: string) {
  sendJson(response, statusCode, { error });
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {} as T;
  }

  return JSON.parse(raw) as T;
}

function normalizeFee(value: unknown): string {
  if (value == null) return "-";
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "string") return String(value);
  return "-";
}

function summarizeEvent(entry: Record<string, unknown>): TransactionEvent | null {
  const msg = typeof entry.msg === "string" ? entry.msg : "";
  const botId = typeof entry.botId === "string" ? entry.botId : null;
  const botName = typeof entry.botName === "string" ? entry.botName : null;
  const time = typeof entry.time === "string" ? entry.time : new Date().toISOString();

  if (msg === "position close evaluated") {
    const feeLamports = normalizeFee((entry.closeSummary as Record<string, unknown> | undefined)?.feeLamports);
    return {
      botId,
      botName,
      time,
      type: "Close",
      status: "Submitted",
      txId: typeof entry.closeTxId === "string" ? entry.closeTxId : null,
      fees: feeLamports,
      summary: typeof entry.positionAddress === "string" ? `Position ${entry.positionAddress}` : "Closed managed position"
    };
  }

  if (msg === "swap plan evaluated") {
    const direction = typeof entry.direction === "string" ? entry.direction : "none";
    const txId = typeof entry.swapTxId === "string" ? entry.swapTxId : null;
    const feeLamports = normalizeFee((entry.swapSummary as Record<string, unknown> | undefined)?.feeLamports);
    return {
      botId,
      botName,
      time,
      type: "Swap",
      status: txId ? "Submitted" : direction === "none" ? "Skipped" : "Planned",
      txId,
      fees: txId ? feeLamports : "-",
      summary: `${direction} ${typeof entry.inputAmount === "string" ? entry.inputAmount : ""}`.trim()
    };
  }

  if (msg === "rebalance finished") {
    const positionAddress = typeof entry.positionAddress === "string" ? entry.positionAddress : null;
    return {
      botId,
      botName,
      time,
      type: "Deposit",
      status: "Completed",
      txId: null,
      fees: "-",
      summary: positionAddress ? `Opened ${positionAddress}` : "Opened position"
    };
  }

  if (msg === "rebalance paused after failure") {
    return {
      botId,
      botName,
      time,
      type: "Rebalance",
      status: "Failed",
      txId: null,
      fees: "-",
      summary: typeof entry.error === "string" ? entry.error : "Rebalance failed"
    };
  }

  if (msg === "transaction timeout detected") {
    return {
      botId,
      botName,
      time,
      type: "Recovery",
      status: "Timeout",
      txId: null,
      fees: "-",
      summary: `${typeof entry.phase === "string" ? entry.phase : "unknown"} phase`
    };
  }

  if (msg === "timeout reconciliation evaluated") {
    return {
      botId,
      botName,
      time,
      type: "Recovery",
      status: "Checked",
      txId: null,
      fees: "-",
      summary: `${typeof entry.phase === "string" ? entry.phase : "unknown"} => ${typeof entry.outcome === "string" ? entry.outcome : "unknown"}`
    };
  }

  if (msg === "fees compounded") {
    return {
      botId,
      botName,
      time,
      type: "Compound",
      status: "Completed",
      txId: null,
      fees: "-",
      summary: `Compounded fees back into position`
    };
  }

  if (msg === "cycle evaluated") {
    if (!(typeof entry.shouldRebalance === "boolean" && entry.shouldRebalance)) return null;
    return {
      botId,
      botName,
      time,
      type: "Trigger",
      status: "Triggered",
      txId: null,
      fees: "-",
      summary: `Price ${entry.currentPrice ?? "-"} range [${entry.minPrice ?? "-"}, ${entry.maxPrice ?? "-"}]`
    };
  }

  return null;
}

function summarizeBot(
  record: Awaited<ReturnType<typeof supervisor.listBots>>[number],
  pnlSummary?: BotPnlSummaryView
) {
  const runtime = record.runtime;
  const definition = record.definition;
  const triggerState = runtime.driftStatus
    ? `${runtime.driftStatus}${runtime.driftDirection ? ` (${runtime.driftDirection})` : ""}`
    : "idle";

  let runState = "Stopped";
  if (runtime.paused) {
    runState = "Paused";
  } else if (runtime.pendingRebalance?.nextRetryAt) {
    runState = "Waiting to retry";
  } else if (runtime.pendingRebalance?.recoveryReason) {
    runState = "Reconciling timeout";
  } else if (definition.enabled && runtime.monitoringActive) {
    runState = runtime.driftStatus === "triggered" ? "Triggered" : "Running";
  }

  return {
    id: definition.id,
    name: definition.name,
    enabled: definition.enabled,
    archived: definition.archived,
    monitoringActive: runtime.monitoringActive,
    dlmmPoolAddress: definition.dlmmPoolAddress,
    allocationUsdc: definition.allocationUsdc,
    minPrice: definition.minPrice,
    maxPrice: definition.maxPrice,
    strategy: definition.strategy,
    binStep: definition.binStep,
    pollSeconds: definition.pollSeconds,
    maxSlippageBps: definition.maxSlippageBps,
    autoCompound: definition.autoCompound,
    compoundMinValueUsdc: definition.compoundMinValueUsdc,
    tokenPair: `${definition.tokenASymbol}/${definition.tokenBSymbol}`,
    tokenASymbol: definition.tokenASymbol,
    tokenBSymbol: definition.tokenBSymbol,
    runState,
    latestAction: runtime.latestAction,
    lastObservedPrice: runtime.lastObservedPrice,
    lastCenterPrice: runtime.lastCenterPrice,
    triggerState,
    activePositionAddress: runtime.activePositionAddress,
    activeLowerBinId: runtime.activeLowerBinId,
    activeUpperBinId: runtime.activeUpperBinId,
    positionLowerPrice: runtime.positionLowerPrice,
    positionUpperPrice: runtime.positionUpperPrice,
    pendingRebalance: runtime.pendingRebalance,
    paused: runtime.paused,
    pauseReason: runtime.pauseReason,
    lastCycleAt: runtime.lastCycleAt,
    pnl: pnlSummary ?? null
  };
}

interface PositionView {
  positionAddress: string;
  dlmmPoolAddress: string;
  lowerPrice: number;
  upperPrice: number;
  tokenPair: string;
  tokenASymbol: string;
  tokenBSymbol: string;
  tokenAAmount: number;
  tokenBAmount: number;
  tokenAValueUsdc: number;
  tokenBValueUsdc: number;
  totalValueUsdc: number;
  feeTokenA: number;
  feeTokenB: number;
  feeTokenAUsdc: number;
  feeTokenBUsdc: number;
  totalFeesUsdc: number;
  feePct: number;
  pnlUsdc: number | null;
  pnlPct: number | null;
  openedAt: string | null;
  isOrphaned: boolean;
  botId: string | null;
  botName: string | null;
  currentPrice: number | null;
}

function buildPositionViews(
  bots: Awaited<ReturnType<typeof supervisor.listBots>>,
  pnl: Awaited<ReturnType<typeof supervisor.getPnlDashboard>>
): PositionView[] {
  const views: PositionView[] = [];
  const liveByAddress = new Map(pnl.livePositions.map((p) => [p.positionAddress, p]));
  const openRecords = new Map(
    pnl.positions.filter((r) => r.status === "open").map((r) => [r.positionAddress, r])
  );

  // Bot-tracked positions
  for (const botRecord of bots) {
    const def = botRecord.definition;
    const rt = botRecord.runtime;
    if (!rt.activePositionAddress) continue;

    const live = liveByAddress.get(rt.activePositionAddress);
    const ledger = openRecords.get(rt.activePositionAddress);
    const decAdj = def.tokenADecimals - def.tokenBDecimals;
    const currentPrice = rt.lastObservedPrice ?? rt.lastCenterPrice ?? 0;

    const tokenAAmount = live ? fromBaseUnits(live.tokenAAmount, def.tokenADecimals) : 0;
    const tokenBAmount = live ? fromBaseUnits(live.tokenBAmount, def.tokenBDecimals) : 0;
    const feeA = live ? fromBaseUnits(live.feeTokenA, def.tokenADecimals) : 0;
    const feeB = live ? fromBaseUnits(live.feeTokenB, def.tokenBDecimals) : 0;
    const tokenAValueUsdc = tokenAAmount * currentPrice;
    const tokenBValueUsdc = tokenBAmount;
    const totalValueUsdc = tokenAValueUsdc + tokenBValueUsdc;
    const feeAUsdc = feeA * currentPrice;
    const feeBUsdc = feeB;
    const totalFees = feeAUsdc + feeBUsdc;
    const feePct = totalValueUsdc > 0 ? (totalFees / totalValueUsdc) * 100 : 0;
    const entryCapital = ledger?.entryCapitalUsdc ?? totalValueUsdc;
    const pnlUsdc = totalValueUsdc - entryCapital;
    const pnlPct = entryCapital > 0 ? (pnlUsdc / entryCapital) * 100 : 0;

    views.push({
      positionAddress: rt.activePositionAddress,
      dlmmPoolAddress: def.dlmmPoolAddress,
      lowerPrice: rt.positionLowerPrice ?? binIdToPrice(rt.activeLowerBinId ?? 0, def.binStep, decAdj),
      upperPrice: rt.positionUpperPrice ?? binIdToPrice(rt.activeUpperBinId ?? 0, def.binStep, decAdj),
      tokenPair: `${def.tokenASymbol}/${def.tokenBSymbol}`,
      tokenASymbol: def.tokenASymbol,
      tokenBSymbol: def.tokenBSymbol,
      tokenAAmount, tokenBAmount,
      tokenAValueUsdc, tokenBValueUsdc, totalValueUsdc,
      feeTokenA: feeA, feeTokenB: feeB,
      feeTokenAUsdc: feeAUsdc, feeTokenBUsdc: feeBUsdc,
      totalFeesUsdc: totalFees, feePct,
      pnlUsdc, pnlPct,
      openedAt: ledger?.openedAt ?? null,
      isOrphaned: false,
      botId: def.id,
      botName: def.name,
      currentPrice
    });

    // Remove from live map so it's not counted as orphaned
    liveByAddress.delete(rt.activePositionAddress);
  }

  // Orphaned positions (remaining live positions not linked to a bot)
  for (const orphan of pnl.orphanedPositions) {
    const live = liveByAddress.get(orphan.positionAddress);
    // Try to find pool metadata from any bot using the same pool
    const matchingBot = bots.find((b) => b.definition.dlmmPoolAddress === orphan.dlmmPoolAddress);
    const decA = matchingBot?.definition.tokenADecimals ?? 9;
    const decB = matchingBot?.definition.tokenBDecimals ?? 6;
    const decAdj = decA - decB;
    const binStep = matchingBot?.definition.binStep ?? 10;
    const tokenASymbol = matchingBot?.definition.tokenASymbol ?? "Token A";
    const tokenBSymbol = matchingBot?.definition.tokenBSymbol ?? "Token B";
    const currentPrice = matchingBot?.runtime.lastObservedPrice ?? matchingBot?.runtime.lastCenterPrice ?? 0;

    const tokenAAmount = live ? fromBaseUnits(live.tokenAAmount, decA) : fromBaseUnits(BigInt(orphan.tokenAAmount), decA);
    const tokenBAmount = live ? fromBaseUnits(live.tokenBAmount, decB) : fromBaseUnits(BigInt(orphan.tokenBAmount), decB);
    const feeA = live ? fromBaseUnits(live.feeTokenA, decA) : fromBaseUnits(BigInt(orphan.feeTokenA), decA);
    const feeB = live ? fromBaseUnits(live.feeTokenB, decB) : fromBaseUnits(BigInt(orphan.feeTokenB), decB);
    const tokenAValueUsdc = tokenAAmount * currentPrice;
    const tokenBValueUsdc = tokenBAmount;
    const totalValueUsdc = tokenAValueUsdc + tokenBValueUsdc;
    const feeAUsdc = feeA * currentPrice;
    const feeBUsdc = feeB;
    const totalFees = feeAUsdc + feeBUsdc;
    const feePct = totalValueUsdc > 0 ? (totalFees / totalValueUsdc) * 100 : 0;

    views.push({
      positionAddress: orphan.positionAddress,
      dlmmPoolAddress: orphan.dlmmPoolAddress,
      lowerPrice: binIdToPrice(orphan.lowerBinId, binStep, decAdj),
      upperPrice: binIdToPrice(orphan.upperBinId, binStep, decAdj),
      tokenPair: `${tokenASymbol}/${tokenBSymbol}`,
      tokenASymbol, tokenBSymbol,
      tokenAAmount, tokenBAmount,
      tokenAValueUsdc, tokenBValueUsdc, totalValueUsdc,
      feeTokenA: feeA, feeTokenB: feeB,
      feeTokenAUsdc: feeAUsdc, feeTokenBUsdc: feeBUsdc,
      totalFeesUsdc: totalFees, feePct,
      pnlUsdc: null, pnlPct: null,
      openedAt: null,
      isOrphaned: true,
      botId: null,
      botName: null,
      currentPrice
    });
  }

  return views;
}

async function serveStatic(pathname: string, response: ServerResponse) {
  const filePath =
    pathname === "/" ? resolve(PUBLIC_DIR, "index.html") : resolve(PUBLIC_DIR, `.${pathname}`);
  if (!filePath.startsWith(PUBLIC_DIR + sep)) {
    return sendError(response, 404, "Not found");
  }
  let file: Buffer;
  try {
    file = await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "EISDIR") {
      return sendError(response, 404, "Not found");
    }
    throw error;
  }
  const contentType =
    pathname.endsWith(".css")
      ? "text/css; charset=utf-8"
      : pathname.endsWith(".js")
        ? "application/javascript; charset=utf-8"
        : "text/html; charset=utf-8";

  const cacheControl = (pathname.endsWith(".js") || pathname.endsWith(".css") || pathname.endsWith(".html"))
    ? "no-cache"
    : "public, max-age=3600";
  response.writeHead(200, { "content-type": contentType, "cache-control": cacheControl });
  response.end(file);
}

async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL) {
  const pathname = url.pathname;
  const method = request.method ?? "GET";
  const parts = pathname.split("/").filter(Boolean);

  if (pathname === "/api/status" && method === "GET") {
    if (statusCache && Date.now() - statusCache.cachedAt < STATUS_CACHE_TTL_MS) {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(statusCache.json);
      return;
    }
    const [wallet, bots, pnl] = await Promise.all([
      supervisor.getWalletSummary(),
      supervisor.listBots(),
      supervisor.getPnlDashboard()
    ]);
    const payload = {
      wallet,
      bots: bots.map((bot) => summarizeBot(bot, pnl.botSummaries[bot.definition.id])),
      pnl: pnl.summary,
      orphanedPositions: pnl.orphanedPositions,
      allPositions: buildPositionViews(bots, pnl)
    };
    const json = JSON.stringify(payload);
    statusCache = { json, cachedAt: Date.now() };
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(json);
    return;
  }

  if (pathname === "/api/bots" && method === "GET") {
    const [bots, pnl] = await Promise.all([supervisor.listBots(), supervisor.getPnlDashboard()]);
    return sendJson(response, 200, { bots: bots.map((bot) => summarizeBot(bot, pnl.botSummaries[bot.definition.id])) });
  }

  if (pathname === "/api/bots" && method === "POST") {
    const payload = await readJson<{
      name: string;
      dlmmPoolAddress: string;
      minPrice: number;
      maxPrice: number;
      strategy: import("./config.js").StrategyType;
      allocationUsdc: number;
      pollSeconds: number;
      maxSlippageBps: number;
      closeRetrySlippageBps: number;
      closeFinalRetrySlippageBps: number;
      openRetrySlippageBps: number;
      openFinalRetrySlippageBps: number;
      slippageRetriesPerTier: number;
      openDeploymentBufferBps: number;
      openRetryDeploymentBufferBps: number;
      openFinalDeploymentBufferBps: number;
      minSwapQuoteValue: number;
      openBalanceToleranceBps: number;
      autoCompound?: boolean;
      compoundMinValueUsdc?: number;
    }>(request);
    const bot = await supervisor.createBot(payload);
    invalidateStatusCache();
    return sendJson(response, 201, { bot: summarizeBot(bot) });
  }

  if (pathname === "/api/wallet" && method === "GET") {
    const wallet = await supervisor.getWalletSummary();
    return sendJson(response, 200, wallet);
  }

  if (pathname === "/api/transactions" && method === "GET") {
    const botId = url.searchParams.get("botId") ?? undefined;
    const events = (await supervisor.getTransactions(config.LOG_FILE, botId))
      .map(summarizeEvent)
      .filter((event): event is TransactionEvent => Boolean(event))
      .slice(-100)
      .reverse();
    return sendJson(response, 200, { events });
  }

  if (pathname === "/api/pnl" && method === "GET") {
    const pnl = await supervisor.getPnlDashboard();
    const { livePositions: _, ...pnlWithoutLive } = pnl;
    return sendJson(response, 200, pnlWithoutLive);
  }

  if (pathname === "/api/pnl/positions" && method === "GET") {
    const pnl = await supervisor.getPnlDashboard();
    return sendJson(response, 200, { positions: pnl.positions });
  }

  if (parts[0] === "api" && parts[1] === "bots" && parts[2]) {
    const botId = parts[2];

    if (method !== "GET") {
      invalidateStatusCache();
    }

    if (parts.length === 3 && method === "PATCH") {
      const payload = await readJson<{
        name?: string;
        allocationUsdc?: number;
        minPrice?: number;
        maxPrice?: number;
        strategy?: import("./config.js").StrategyType;
        pollSeconds?: number;
        maxSlippageBps?: number;
        autoCompound?: boolean;
        compoundMinValueUsdc?: number;
      }>(request);
      const bot = await supervisor.updateBot(botId, payload);
      if (!bot) return sendError(response, 404, "Bot not found");
      const pnl = await supervisor.getPnlDashboard();
      return sendJson(response, 200, { bot: summarizeBot(bot, pnl.botSummaries[bot.definition.id]) });
    }

    if (parts.length === 3 && method === "DELETE") {
      const bot = await supervisor.archiveBot(botId);
      if (!bot) return sendError(response, 404, "Bot not found");
      return sendNoContent(response);
    }

    if (parts[3] === "start" && method === "POST") {
      const bot = await supervisor.startBot(botId);
      if (!bot) return sendError(response, 404, "Bot not found");
      const pnl = await supervisor.getPnlDashboard();
      return sendJson(response, 200, { bot: summarizeBot(bot, pnl.botSummaries[bot.definition.id]) });
    }

    if (parts[3] === "stop" && method === "POST") {
      const bot = await supervisor.stopBot(botId);
      if (!bot) return sendError(response, 404, "Bot not found");
      const pnl = await supervisor.getPnlDashboard();
      return sendJson(response, 200, { bot: summarizeBot(bot, pnl.botSummaries[bot.definition.id]) });
    }

    if (parts[3] === "pause" && method === "POST") {
      const bot = await supervisor.pauseBot(botId);
      if (!bot) return sendError(response, 404, "Bot not found");
      const pnl = await supervisor.getPnlDashboard();
      return sendJson(response, 200, { bot: summarizeBot(bot, pnl.botSummaries[bot.definition.id]) });
    }

    if (parts[3] === "resume" && method === "POST") {
      const bot = await supervisor.resumeBot(botId);
      if (!bot) return sendError(response, 404, "Bot not found");
      const pnl = await supervisor.getPnlDashboard();
      return sendJson(response, 200, { bot: summarizeBot(bot, pnl.botSummaries[bot.definition.id]) });
    }

    if (parts[3] === "rebalance" && method === "POST") {
      await supervisor.rebalanceNow(botId);
      invalidateStatusCache();
      return sendNoContent(response);
    }

    if (parts[3] === "close-position" && method === "POST") {
      const result = await supervisor.closePositionNow(botId);
      invalidateStatusCache();
      if (!result) return sendError(response, 404, "No active position to close");
      return sendJson(response, 200, { positionAddress: result.positionAddress, txId: result.txId });
    }

    if (parts[3] === "compound" && method === "POST") {
      const result = await supervisor.compoundFees(botId);
      invalidateStatusCache();
      if (!result) return sendError(response, 404, "No active position to compound");
      return sendJson(response, 200, {
        feesTokenA: result.feesTokenA.toString(),
        feesTokenB: result.feesTokenB.toString(),
        claimTxIds: result.claimTxIds,
        depositTxIds: result.depositTxIds
      });
    }

    if (parts[3] === "transactions" && method === "GET") {
      const events = (await supervisor.getTransactions(config.LOG_FILE, botId))
        .map(summarizeEvent)
        .filter((event): event is TransactionEvent => Boolean(event))
        .slice(-60)
        .reverse();
      return sendJson(response, 200, { events });
    }
  }

  sendError(response, 404, "Not found");
}

async function main() {
  await supervisor.init();

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!(await authenticate(request, response, url))) {
        return;
      }
      if (url.pathname === "/login") {
        response.writeHead(303, { location: "/" });
        response.end();
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        await handleApi(request, response, url);
        return;
      }

      await serveStatic(url.pathname, response);
    } catch (error) {
      sendError(response, 500, (error as Error).message);
    }
  });

  server.listen(PORT, HOST, () => {
    logger.info({ host: HOST, port: PORT, auth: UI_TOKEN ? "token" : "none" }, "meteora bot control panel listening");
    if (!UI_TOKEN && !isLoopbackHost(HOST)) {
      logger.warn(
        { host: HOST, port: PORT },
        "control panel is bound to a non-loopback address WITHOUT authentication: anyone who can reach this port " +
          "can trade the wallet's funds. Set UI_TOKEN, or bind to 127.0.0.1 with UI_HOST."
      );
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
