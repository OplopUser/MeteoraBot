import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { PositionPnlLedger, PositionPnlRecord } from "../domain.js";

const LEDGER_VERSION = 1 as const;

function createDefaultLedger(): PositionPnlLedger {
  return {
    version: LEDGER_VERSION,
    positions: []
  };
}

export class PnlLedgerStore {
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<PositionPnlLedger> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PositionPnlLedger>;
      return this.normalize(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return createDefaultLedger();
      }

      throw error;
    }
  }

  async listRecords(): Promise<PositionPnlRecord[]> {
    const ledger = await this.load();
    return ledger.positions
      .slice()
      .sort((left, right) => {
        const leftTime = left.closedAt ?? left.openedAt;
        const rightTime = right.closedAt ?? right.openedAt;
        return rightTime.localeCompare(leftTime);
      });
  }

  async getRecordByPositionAddress(positionAddress: string): Promise<PositionPnlRecord | null> {
    const ledger = await this.load();
    return ledger.positions.find((record) => record.positionAddress === positionAddress) ?? null;
  }

  async getOpenRecordByBotId(botId: string): Promise<PositionPnlRecord | null> {
    const ledger = await this.load();
    return ledger.positions.find((record) => record.botId === botId && record.status === "open") ?? null;
  }

  async saveRecord(record: PositionPnlRecord): Promise<void> {
    await this.withExclusive(async () => {
      const ledger = await this.load();
      const index = ledger.positions.findIndex((candidate) => candidate.id === record.id);

      if (index >= 0) {
        ledger.positions[index] = record;
      } else {
        ledger.positions.push(record);
      }

      await this.save(ledger);
    });
  }

  async saveMany(records: PositionPnlRecord[]): Promise<void> {
    await this.withExclusive(async () => {
      const ledger = await this.load();
      const byId = new Map(ledger.positions.map((record) => [record.id, record]));

      for (const record of records) {
        byId.set(record.id, record);
      }

      ledger.positions = [...byId.values()];
      await this.save(ledger);
    });
  }

  private async save(ledger: PositionPnlLedger) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(ledger, null, 2));
    await rename(tempPath, this.filePath);
  }

  private normalize(ledger: Partial<PositionPnlLedger>): PositionPnlLedger {
    return {
      version: LEDGER_VERSION,
      positions: Array.isArray(ledger.positions) ? ledger.positions : []
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
