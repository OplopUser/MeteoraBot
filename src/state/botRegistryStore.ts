import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import type { AppConfig, StrategyType } from "../config.js";
import type {
  BotDefinition,
  BotId,
  BotRecord,
  BotRegistry,
  BotRuntimeState,
  PoolMetadata
} from "../domain.js";
import { createEmptyBotRuntimeState } from "./store.js";

const REGISTRY_VERSION = 1 as const;

export interface CreateBotInput {
  name: string;
  dlmmPoolAddress: string;
  minPrice: number;
  maxPrice: number;
  strategy: StrategyType;
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
  driftThresholdPct?: number;
  rangeBins?: number | null;
  trendShiftBins?: number;
}

export interface UpdateBotInput extends Partial<CreateBotInput> {
  enabled?: boolean;
  archived?: boolean;
  monitoringActive?: boolean;
  paused?: boolean;
  pauseReason?: string | null;
  resetPause?: boolean;
}

function createDefaultRegistry(): BotRegistry {
  return {
    version: REGISTRY_VERSION,
    bots: []
  };
}

export class BotRegistryStore {
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly config: AppConfig
  ) {}

  async load(): Promise<BotRegistry> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<BotRegistry>;
      return this.normalizeRegistry(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }

      return createDefaultRegistry();
    }
  }

  async save(registry: BotRegistry): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(registry, null, 2));
    await rename(tempPath, this.filePath);
  }

  async listBots(): Promise<BotRecord[]> {
    const registry = await this.load();
    return registry.bots.filter((bot) => !bot.definition.archived);
  }

  async listAllBots(): Promise<BotRecord[]> {
    const registry = await this.load();
    return registry.bots;
  }

  async getBot(botId: BotId): Promise<BotRecord | null> {
    const bots = await this.listBots();
    return bots.find((bot) => bot.definition.id === botId) ?? null;
  }

  async createBot(input: CreateBotInput, metadata: PoolMetadata): Promise<BotRecord> {
    return this.withExclusive(async () => {
      const registry = await this.load();
      const now = new Date().toISOString();
      const record: BotRecord = {
        definition: {
          id: randomUUID(),
          name: input.name.trim() || `${metadata.tokenASymbol}/${metadata.tokenBSymbol} Bot`,
          enabled: true,
          archived: false,
          dlmmPoolAddress: metadata.dlmmPoolAddress,
          minPrice: input.minPrice,
          maxPrice: input.maxPrice,
          strategy: input.strategy,
          binStep: metadata.binStep,
          allocationUsdc: input.allocationUsdc,
          pollSeconds: input.pollSeconds,
          maxSlippageBps: input.maxSlippageBps,
          closeRetrySlippageBps: input.closeRetrySlippageBps,
          closeFinalRetrySlippageBps: input.closeFinalRetrySlippageBps,
          openRetrySlippageBps: input.openRetrySlippageBps,
          openFinalRetrySlippageBps: input.openFinalRetrySlippageBps,
          slippageRetriesPerTier: input.slippageRetriesPerTier,
          openDeploymentBufferBps: input.openDeploymentBufferBps,
          openRetryDeploymentBufferBps: input.openRetryDeploymentBufferBps,
          openFinalDeploymentBufferBps: input.openFinalDeploymentBufferBps,
          minSwapQuoteValue: input.minSwapQuoteValue,
          openBalanceToleranceBps: input.openBalanceToleranceBps,
          autoCompound: input.autoCompound ?? false,
          compoundMinValueUsdc: input.compoundMinValueUsdc ?? 0,
          driftThresholdPct: input.driftThresholdPct ?? 0,
          rangeBins: input.rangeBins ?? null,
          trendShiftBins: input.trendShiftBins ?? 0,
          tokenAMint: metadata.tokenAMint,
          tokenASymbol: metadata.tokenASymbol,
          tokenADecimals: metadata.tokenADecimals,
          tokenBMint: metadata.tokenBMint,
          tokenBSymbol: metadata.tokenBSymbol,
          tokenBDecimals: metadata.tokenBDecimals,
          createdAt: now,
          updatedAt: now
        },
        runtime: {
          ...createEmptyBotRuntimeState(),
          monitoringActive: false
        }
      };

      registry.bots.push(record);
      await this.save(registry);
      return record;
    });
  }

  async updateBot(botId: BotId, input: UpdateBotInput): Promise<BotRecord | null> {
    return this.withExclusive(async () => {
      const registry = await this.load();
      const record = registry.bots.find((bot) => bot.definition.id === botId);
      if (!record) {
        return null;
      }

      const now = new Date().toISOString();
      const def = record.definition;

      if (typeof input.name === "string") def.name = input.name.trim() || def.name;
      if (typeof input.enabled === "boolean") def.enabled = input.enabled;
      if (typeof input.archived === "boolean") def.archived = input.archived;
      if (typeof input.minPrice === "number") def.minPrice = input.minPrice;
      if (typeof input.maxPrice === "number") def.maxPrice = input.maxPrice;
      if (input.strategy) def.strategy = input.strategy;
      if (typeof input.allocationUsdc === "number") def.allocationUsdc = input.allocationUsdc;
      if (typeof input.pollSeconds === "number") def.pollSeconds = input.pollSeconds;
      if (typeof input.maxSlippageBps === "number") def.maxSlippageBps = input.maxSlippageBps;
      if (typeof input.closeRetrySlippageBps === "number") def.closeRetrySlippageBps = input.closeRetrySlippageBps;
      if (typeof input.closeFinalRetrySlippageBps === "number") def.closeFinalRetrySlippageBps = input.closeFinalRetrySlippageBps;
      if (typeof input.openRetrySlippageBps === "number") def.openRetrySlippageBps = input.openRetrySlippageBps;
      if (typeof input.openFinalRetrySlippageBps === "number") def.openFinalRetrySlippageBps = input.openFinalRetrySlippageBps;
      if (typeof input.slippageRetriesPerTier === "number") def.slippageRetriesPerTier = input.slippageRetriesPerTier;
      if (typeof input.openDeploymentBufferBps === "number") def.openDeploymentBufferBps = input.openDeploymentBufferBps;
      if (typeof input.openRetryDeploymentBufferBps === "number") def.openRetryDeploymentBufferBps = input.openRetryDeploymentBufferBps;
      if (typeof input.openFinalDeploymentBufferBps === "number") def.openFinalDeploymentBufferBps = input.openFinalDeploymentBufferBps;
      if (typeof input.minSwapQuoteValue === "number") def.minSwapQuoteValue = input.minSwapQuoteValue;
      if (typeof input.openBalanceToleranceBps === "number") def.openBalanceToleranceBps = input.openBalanceToleranceBps;
      if (typeof input.autoCompound === "boolean") def.autoCompound = input.autoCompound;
      if (typeof input.compoundMinValueUsdc === "number") def.compoundMinValueUsdc = input.compoundMinValueUsdc;
      if (typeof input.driftThresholdPct === "number") def.driftThresholdPct = input.driftThresholdPct;
      if (input.rangeBins !== undefined) def.rangeBins = input.rangeBins ?? null;
      if (typeof input.trendShiftBins === "number") def.trendShiftBins = input.trendShiftBins;
      def.updatedAt = now;

      if (typeof input.monitoringActive === "boolean") record.runtime.monitoringActive = input.monitoringActive;
      if (typeof input.paused === "boolean") record.runtime.paused = input.paused;
      if (typeof input.pauseReason === "string" || input.pauseReason === null) record.runtime.pauseReason = input.pauseReason;
      if (input.resetPause) {
        record.runtime.paused = false;
        record.runtime.pauseReason = null;
      }

      await this.save(registry);
      return record;
    });
  }

  async saveRuntime(botId: BotId, runtime: BotRuntimeState): Promise<void> {
    await this.withExclusive(async () => {
      const registry = await this.load();
      const record = registry.bots.find((bot) => bot.definition.id === botId);
      if (!record) {
        throw new Error(`Bot ${botId} not found`);
      }

      record.runtime = {
        ...createEmptyBotRuntimeState(),
        ...runtime
      };
      record.definition.updatedAt = new Date().toISOString();
      await this.save(registry);
    });
  }

  async archiveBot(botId: BotId): Promise<BotRecord | null> {
    return this.updateBot(botId, {
      archived: true,
      enabled: false,
      monitoringActive: false
    });
  }

  private normalizeRegistry(registry: Partial<BotRegistry>): BotRegistry {
    const bots = Array.isArray(registry.bots) ? registry.bots : [];

    return {
      version: REGISTRY_VERSION,
      bots: bots.map((bot) => ({
        definition: {
          ...bot.definition,
          autoCompound: bot.definition.autoCompound ?? false,
          compoundMinValueUsdc: bot.definition.compoundMinValueUsdc ?? 0,
          driftThresholdPct: bot.definition.driftThresholdPct ?? 0,
          rangeBins: bot.definition.rangeBins ?? null,
          trendShiftBins: bot.definition.trendShiftBins ?? 0
        },
        runtime: {
          ...createEmptyBotRuntimeState(),
          ...bot.runtime
        }
      }))
    };
  }

  private async withExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.mutationChain;
    let release!: () => void;
    this.mutationChain = new Promise<void>((resolve) => {
      release = resolve;
    });

    await prior;

    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export class BotRuntimeStore {
  constructor(
    private readonly registryStore: BotRegistryStore,
    private readonly botId: BotId
  ) {}

  async load(): Promise<BotRuntimeState> {
    const record = await this.registryStore.getBot(this.botId);
    return record?.runtime ?? createEmptyBotRuntimeState();
  }

  async save(state: BotRuntimeState): Promise<void> {
    await this.registryStore.saveRuntime(this.botId, state);
  }
}
