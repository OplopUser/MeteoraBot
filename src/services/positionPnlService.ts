import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type {
  BotRecord,
  BotDefinition,
  GlobalPnlSummary,
  ManagedPosition,
  PositionLedgerCloseInput,
  PositionLedgerMarkInput,
  PositionLedgerOpenInput,
  PositionPnlRecord,
  BotPnlSummary
} from "../domain.js";
import { PnlLedgerStore } from "../state/pnlLedgerStore.js";
import {
  computeNetPnl,
  lamportsToUsdc,
  quoteValueFromRaw,
  resolveTokenPricesUsdc,
  type TokenPricesUsdc,
  summarizeBotPnl,
  summarizeGlobalPnl
} from "./pnlMath.js";

export interface OrphanedPositionView {
  positionAddress: string;
  dlmmPoolAddress: string;
  lowerBinId: number;
  upperBinId: number;
  tokenAAmount: string;
  tokenBAmount: string;
  feeTokenA: string;
  feeTokenB: string;
}

export interface PnlDashboardSnapshot {
  summary: GlobalPnlSummary;
  botSummaries: Record<string, BotPnlSummary>;
  positions: PositionPnlRecord[];
  orphanedPositions: OrphanedPositionView[];
  livePositions: ManagedPosition[];
}

type TokenPriceResolver = (
  bot: BotDefinition,
  bots: BotRecord[],
  currentPrice: number
) => Promise<TokenPricesUsdc | null>;

export class PositionPnlService {
  constructor(
    private readonly ledgerStore: PnlLedgerStore,
    private readonly logger: Logger,
    private readonly resolveTokenPrices: TokenPriceResolver = async (bot, bots, currentPrice) =>
      resolveTokenPricesUsdc(bot, currentPrice, bots)
  ) {}

  async recordPositionOpened(bot: BotDefinition, bots: BotRecord[], input: PositionLedgerOpenInput) {
    const prices = await this.resolveTokenPrices(bot, bots, input.centerPrice);
    if (!prices) {
      this.logger.warn({ botId: bot.id, positionAddress: input.positionAddress }, "skipping pnl open record because token prices could not be resolved");
      return;
    }

    const record: PositionPnlRecord = {
      id: randomUUID(),
      botId: input.botId,
      botName: input.botName,
      dlmmPoolAddress: input.dlmmPoolAddress,
      tokenPair: input.tokenPair,
      positionAddress: input.positionAddress,
      status: "open",
      openedAt: input.openedAt,
      closedAt: null,
      entryCenterPrice: input.centerPrice,
      entryLowerPrice: input.lowerPrice,
      entryUpperPrice: input.upperPrice,
      entryCapitalUsdc: input.entryCapitalQuote * prices.tokenBUsdc,
      entryTokenA: input.entryTokenA,
      entryTokenB: input.entryTokenB,
      residualTokenA: input.residualTokenA,
      residualTokenB: input.residualTokenB,
      cumulativeSwapFeesUsdc: input.cumulativeSwapFeeQuote * prices.tokenBUsdc,
      cumulativeTxFeesUsdc: lamportsToUsdc(input.cumulativeTxFeeLamports, prices.solUsdc),
      feesEarnedUsdc: 0,
      latestGrossValueUsdc: input.entryCapitalQuote * prices.tokenBUsdc,
      latestNetPnlUsdc: computeNetPnl(
        input.entryCapitalQuote * prices.tokenBUsdc,
        input.entryCapitalQuote * prices.tokenBUsdc,
        input.cumulativeSwapFeeQuote * prices.tokenBUsdc,
        lamportsToUsdc(input.cumulativeTxFeeLamports, prices.solUsdc)
      ),
      lastMarkedAt: input.openedAt,
      exitGrossValueUsdc: null,
      realizedNetPnlUsdc: null,
      openTxId: input.openTxId,
      closeTxId: null,
      bootstrapped: Boolean(input.bootstrapped)
    };

    const existingOpen = await this.ledgerStore.getOpenRecordByBotId(bot.id);
    if (existingOpen && existingOpen.positionAddress !== input.positionAddress) {
      existingOpen.status = "closed";
      existingOpen.closedAt = input.openedAt;
      existingOpen.exitGrossValueUsdc = existingOpen.latestGrossValueUsdc;
      existingOpen.realizedNetPnlUsdc = existingOpen.latestNetPnlUsdc;
      existingOpen.closeTxId = existingOpen.closeTxId ?? "superseded";
      await this.ledgerStore.saveRecord(existingOpen);
    }

    await this.ledgerStore.saveRecord(record);
  }

  async recordPositionClosed(bot: BotDefinition, bots: BotRecord[], input: PositionLedgerCloseInput) {
    const record = await this.ledgerStore.getRecordByPositionAddress(input.positionAddress);
    const prices = await this.resolveTokenPrices(bot, bots, input.centerPrice);
    if (!prices) {
      this.logger.warn({ botId: bot.id, positionAddress: input.positionAddress }, "skipping pnl close record because token prices could not be resolved");
      return;
    }

    const exitGrossValueUsdc = input.exitGrossQuote * prices.tokenBUsdc;
    const closeTxFeesUsdc = lamportsToUsdc(input.closeTxFeeLamports, prices.solUsdc);

    if (!record) {
      const bootstrapped: PositionPnlRecord = {
        id: randomUUID(),
        botId: input.botId,
        botName: bot.name,
        dlmmPoolAddress: bot.dlmmPoolAddress,
        tokenPair: `${bot.tokenASymbol}/${bot.tokenBSymbol}`,
        positionAddress: input.positionAddress,
        status: "closed",
        openedAt: input.closedAt,
        closedAt: input.closedAt,
        entryCenterPrice: input.centerPrice,
        entryLowerPrice: null,
        entryUpperPrice: null,
        entryCapitalUsdc: exitGrossValueUsdc,
        entryTokenA: "0",
        entryTokenB: "0",
        residualTokenA: "0",
        residualTokenB: "0",
        cumulativeSwapFeesUsdc: 0,
        cumulativeTxFeesUsdc: closeTxFeesUsdc,
        feesEarnedUsdc: input.feesEarnedQuote * prices.tokenBUsdc,
        latestGrossValueUsdc: exitGrossValueUsdc,
        latestNetPnlUsdc: -closeTxFeesUsdc,
        lastMarkedAt: input.closedAt,
        exitGrossValueUsdc,
        realizedNetPnlUsdc: -closeTxFeesUsdc,
        openTxId: null,
        closeTxId: input.closeTxId,
        bootstrapped: true
      };
      await this.ledgerStore.saveRecord(bootstrapped);
      return;
    }

    // Rebase entry capital
    const entryTokenA = this.parseBigInt(record.entryTokenA);
    const entryTokenB = this.parseBigInt(record.entryTokenB);
    if ((entryTokenA > 0n || entryTokenB > 0n) && record.entryCenterPrice > 0) {
      record.entryCapitalUsdc = quoteValueFromRaw(
        record.entryCenterPrice,
        entryTokenA,
        entryTokenB,
        bot.tokenADecimals,
        bot.tokenBDecimals
      ) * prices.tokenBUsdc;
    }

    record.status = "closed";
    record.closedAt = input.closedAt;
    record.cumulativeTxFeesUsdc += closeTxFeesUsdc;
    record.feesEarnedUsdc = input.feesEarnedQuote * prices.tokenBUsdc;
    record.latestGrossValueUsdc = exitGrossValueUsdc;
    record.latestNetPnlUsdc = computeNetPnl(
      exitGrossValueUsdc,
      record.entryCapitalUsdc,
      record.cumulativeSwapFeesUsdc,
      record.cumulativeTxFeesUsdc
    );
    record.lastMarkedAt = input.closedAt;
    record.exitGrossValueUsdc = exitGrossValueUsdc;
    record.realizedNetPnlUsdc = record.latestNetPnlUsdc;
    record.closeTxId = input.closeTxId;

    await this.ledgerStore.saveRecord(record);
  }

  async markOpenPosition(bot: BotDefinition, bots: BotRecord[], input: PositionLedgerMarkInput) {
    let record = await this.ledgerStore.getRecordByPositionAddress(input.positionAddress);
    const prices = await this.resolveTokenPrices(bot, bots, input.centerPrice);
    if (!prices) {
      this.logger.warn({ botId: bot.id, positionAddress: input.positionAddress }, "skipping pnl mark because token prices could not be resolved");
      return;
    }

    if (!record) {
      record = {
        id: randomUUID(),
        botId: bot.id,
        botName: bot.name,
        dlmmPoolAddress: bot.dlmmPoolAddress,
        tokenPair: `${bot.tokenASymbol}/${bot.tokenBSymbol}`,
        positionAddress: input.positionAddress,
        status: "open",
        openedAt: input.markedAt,
        closedAt: null,
        entryCenterPrice: input.centerPrice,
        entryLowerPrice: null,
        entryUpperPrice: null,
        entryCapitalUsdc: input.grossValueQuote * prices.tokenBUsdc,
        entryTokenA: "0",
        entryTokenB: "0",
        residualTokenA: "0",
        residualTokenB: "0",
        cumulativeSwapFeesUsdc: 0,
        cumulativeTxFeesUsdc: 0,
        feesEarnedUsdc: input.feesEarnedQuote * prices.tokenBUsdc,
        latestGrossValueUsdc: input.grossValueQuote * prices.tokenBUsdc,
        latestNetPnlUsdc: 0,
        lastMarkedAt: input.markedAt,
        exitGrossValueUsdc: null,
        realizedNetPnlUsdc: null,
        openTxId: null,
        closeTxId: null,
        bootstrapped: true
      };
    }

    const latestGrossValueUsdc = input.grossValueQuote * prices.tokenBUsdc;

    // Rebase entry capital
    const entryTokenA = this.parseBigInt(record.entryTokenA);
    const entryTokenB = this.parseBigInt(record.entryTokenB);
    if ((entryTokenA > 0n || entryTokenB > 0n) && record.entryCenterPrice > 0) {
      record.entryCapitalUsdc = quoteValueFromRaw(
        record.entryCenterPrice,
        entryTokenA,
        entryTokenB,
        bot.tokenADecimals,
        bot.tokenBDecimals
      ) * prices.tokenBUsdc;
    }

    record.feesEarnedUsdc = input.feesEarnedQuote * prices.tokenBUsdc;
    record.latestGrossValueUsdc = latestGrossValueUsdc;
    record.latestNetPnlUsdc = computeNetPnl(
      latestGrossValueUsdc,
      record.entryCapitalUsdc,
      record.cumulativeSwapFeesUsdc,
      record.cumulativeTxFeesUsdc
    );
    record.lastMarkedAt = input.markedAt;

    await this.ledgerStore.saveRecord(record);
  }

  async getDashboardSnapshot(bots: BotRecord[], livePositions: ManagedPosition[]): Promise<PnlDashboardSnapshot> {
    let positions = await this.ledgerStore.listRecords();
    const livePositionAddresses = livePositions.map((p) => p.positionAddress);
    const livePositionSet = new Set(livePositionAddresses);
    const runtimePositionAddresses = new Set<string>(
      bots
        .map((bot) => bot.runtime.activePositionAddress)
        .filter((addr): addr is string => Boolean(addr))
    );
    const staleOpenRecords = positions
      .filter((record) =>
        record.status === "open" &&
        !livePositionSet.has(record.positionAddress) &&
        !runtimePositionAddresses.has(record.positionAddress)
      )
      .map((record) => ({
        ...record,
        status: "closed" as const,
        closedAt: record.closedAt ?? record.lastMarkedAt ?? record.openedAt,
        exitGrossValueUsdc: record.exitGrossValueUsdc ?? record.latestGrossValueUsdc,
        realizedNetPnlUsdc: record.realizedNetPnlUsdc ?? record.latestNetPnlUsdc,
        closeTxId: record.closeTxId ?? "reconciled-missing-on-chain"
      }));

    if (staleOpenRecords.length > 0) {
      await this.ledgerStore.saveMany(staleOpenRecords);
      positions = await this.ledgerStore.listRecords();
    }

    const activePositionAddresses = new Set<string>(
      bots
        .filter((bot) => bot.definition.enabled && !bot.definition.archived && bot.runtime.activePositionAddress)
        .map((bot) => bot.runtime.activePositionAddress!)
    );
    const botSummaries = Object.fromEntries(
      bots.map((bot) => [bot.definition.id, summarizeBotPnl(positions, bot.definition.id, activePositionAddresses)])
    );
    const orphanedPositions = livePositions
      .filter((p) => !positions.some((record) => record.status === "open" && record.positionAddress === p.positionAddress))
      .map((p) => ({
        positionAddress: p.positionAddress,
        dlmmPoolAddress: p.dlmmPoolAddress,
        lowerBinId: p.lowerBinId,
        upperBinId: p.upperBinId,
        tokenAAmount: p.tokenAAmount.toString(),
        tokenBAmount: p.tokenBAmount.toString(),
        feeTokenA: p.feeTokenA.toString(),
        feeTokenB: p.feeTokenB.toString()
      }));

    return {
      summary: summarizeGlobalPnl(positions, orphanedPositions.length, activePositionAddresses),
      botSummaries,
      positions,
      orphanedPositions,
      livePositions
    };
  }

  private parseBigInt(value: string) {
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  }
}
