import { isRecoverableRpcError, isRecoverableRpcStatus } from "./rpcFailover.js";

export interface TransactionSummary {
  signature: string;
  slot: number | null;
  feeLamports: number | null;
  computeUnitsConsumed: number | null;
  confirmationStatus: string | null;
  error: unknown;
}

export interface OwnerTokenDebitSummary {
  tokenDebits: Record<string, bigint>;
}

interface RpcResponse<T> {
  result?: T;
  error?: { message: string };
}

interface TransactionMetaResponse {
  slot?: number;
  meta?: {
    fee?: number;
    err?: unknown;
    computeUnitsConsumed?: number;
    preTokenBalances?: TokenBalanceEntry[] | null;
    postTokenBalances?: TokenBalanceEntry[] | null;
  } | null;
  confirmationStatus?: string | null;
}

interface TokenBalanceEntry {
  accountIndex?: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: {
    amount?: string;
  } | null;
}

export function extractOwnerTokenDebits(
  preTokenBalances: TokenBalanceEntry[] | null | undefined,
  postTokenBalances: TokenBalanceEntry[] | null | undefined,
  ownerAddress: string,
  mints: string[]
): OwnerTokenDebitSummary | null {
  const targetMints = new Set(mints);
  const balances = new Map<string, { pre: bigint; post: bigint }>();

  const accumulate = (
    entries: TokenBalanceEntry[] | null | undefined,
    phase: "pre" | "post"
  ) => {
    for (const entry of entries ?? []) {
      if (entry.owner !== ownerAddress || !entry.mint || !targetMints.has(entry.mint)) {
        continue;
      }

      const amount = entry.uiTokenAmount?.amount;
      if (!amount) {
        continue;
      }

      const current = balances.get(entry.mint) ?? { pre: 0n, post: 0n };
      current[phase] += BigInt(amount);
      balances.set(entry.mint, current);
    }
  };

  accumulate(preTokenBalances, "pre");
  accumulate(postTokenBalances, "post");

  const tokenDebits: Record<string, bigint> = {};
  for (const mint of mints) {
    const balance = balances.get(mint);
    if (!balance) {
      continue;
    }

    const debit = balance.pre > balance.post ? balance.pre - balance.post : 0n;
    if (debit > 0n) {
      tokenDebits[mint] = debit;
    }
  }

  return Object.keys(tokenDebits).length ? { tokenDebits } : null;
}

export class TransactionInspector {
  private readonly rpcUrls: string[];
  private currentRpcIndex = 0;

  constructor(rpcUrls: string | string[]) {
    this.rpcUrls = Array.isArray(rpcUrls) ? rpcUrls : [rpcUrls];
  }

  async inspect(signature: string): Promise<TransactionSummary | null> {
    const transaction = await this.fetchTransaction(signature);
    if (!transaction) {
      return null;
    }

    return {
      signature,
      slot: transaction.slot ?? null,
      feeLamports: transaction.meta?.fee ?? null,
      computeUnitsConsumed: transaction.meta?.computeUnitsConsumed ?? null,
      confirmationStatus: transaction.confirmationStatus ?? null,
      error: transaction.meta?.err ?? null
    };
  }

  async inspectOwnerTokenDebits(
    signature: string,
    ownerAddress: string,
    mints: string[]
  ): Promise<OwnerTokenDebitSummary | null> {
    const transaction = await this.fetchTransaction(signature);
    if (!transaction?.meta) {
      return null;
    }

    return extractOwnerTokenDebits(
      transaction.meta.preTokenBalances,
      transaction.meta.postTokenBalances,
      ownerAddress,
      mints
    );
  }

  private async fetchTransaction(signature: string): Promise<TransactionMetaResponse | null> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.rpcUrls.length; attempt += 1) {
      const rpcUrl = this.rpcUrls[this.currentRpcIndex];

      try {
        const response = await fetch(rpcUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getTransaction",
            params: [
              signature,
              {
                commitment: "confirmed",
                maxSupportedTransactionVersion: 0,
                encoding: "jsonParsed"
              }
            ]
          })
        });

        if (!response.ok) {
          const error = new Error(`RPC request getTransaction failed with status ${response.status}`);
          if (isRecoverableRpcStatus(response.status) && attempt < this.rpcUrls.length - 1) {
            lastError = error;
            this.advanceRpcUrl();
            continue;
          }
          throw error;
        }

        const body = (await response.json()) as RpcResponse<TransactionMetaResponse | null>;
        if (body.error) {
          throw new Error(`RPC request getTransaction failed: ${body.error.message}`);
        }

        if (!("result" in body)) {
          throw new Error("RPC request getTransaction returned an empty result");
        }

        if (!body.result) {
          return null;
        }

        return body.result;
      } catch (error) {
        if (isRecoverableRpcError(error) && attempt < this.rpcUrls.length - 1) {
          lastError = error as Error;
          this.advanceRpcUrl();
          continue;
        }

        throw error;
      }
    }

    throw lastError ?? new Error("RPC request getTransaction failed");
  }

  private advanceRpcUrl() {
    this.currentRpcIndex = (this.currentRpcIndex + 1) % this.rpcUrls.length;
  }
}
