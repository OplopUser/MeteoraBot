import type { WalletBalances } from "../domain.js";
import { isRecoverableRpcError, isRecoverableRpcStatus } from "./rpcFailover.js";

interface RpcResponse<T> {
  result?: T;
  error?: { message: string };
}

export interface WalletAssetBalance {
  mint: string;
  amount: bigint;
  decimals: number;
}

export class RpcAccountReader {
  private static readonly SOL_MINT = "So11111111111111111111111111111111111111112";
  private readonly rpcUrls: string[];
  private currentRpcIndex = 0;

  constructor(rpcUrls: string | string[]) {
    this.rpcUrls = Array.isArray(rpcUrls) ? rpcUrls : [rpcUrls];
  }

  async getWalletBalances(owner: string, tokenAMint: string, tokenBMint: string): Promise<WalletBalances> {
    const [tokenA, tokenB] = await Promise.all([
      this.getBalanceForMint(owner, tokenAMint),
      this.getBalanceForMint(owner, tokenBMint)
    ]);

    return { tokenA, tokenB };
  }

  async listWalletAssets(owner: string): Promise<WalletAssetBalance[]> {
    const [lamports, tokenAccounts] = await Promise.all([
      this.rpcRequest<{ value: number }>("getBalance", [owner, { commitment: "confirmed" }]),
      this.rpcRequest<{
        value: Array<{
          account: {
            data: {
              parsed?: {
                info?: {
                  mint?: string;
                  tokenAmount?: {
                    amount?: string;
                    decimals?: number;
                  };
                };
              };
            };
          };
        }>;
      }>("getTokenAccountsByOwner", [
        owner,
        { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
        { encoding: "jsonParsed", commitment: "confirmed" }
      ])
    ]);

    const assets = new Map<string, WalletAssetBalance>();
    assets.set(RpcAccountReader.SOL_MINT, {
      mint: RpcAccountReader.SOL_MINT,
      amount: BigInt(lamports.value),
      decimals: 9
    });

    for (const account of tokenAccounts.value ?? []) {
      const mint = account.account.data.parsed?.info?.mint;
      const amount = account.account.data.parsed?.info?.tokenAmount?.amount;
      const decimals = account.account.data.parsed?.info?.tokenAmount?.decimals;
      if (!mint || !amount || typeof decimals !== "number") {
        continue;
      }

      const existing = assets.get(mint);
      const nextAmount = BigInt(amount);
      assets.set(mint, {
        mint,
        amount: (existing?.amount ?? 0n) + nextAmount,
        decimals
      });
    }

    return [...assets.values()].filter((asset) => asset.amount > 0n && asset.decimals > 0);
  }

  async getTokenDecimals(mint: string): Promise<number> {
    const supply = await this.rpcRequest<{
      value: {
        decimals: number;
      };
    }>("getTokenSupply", [mint, { commitment: "confirmed" }]);

    return supply.value.decimals;
  }

  private async getBalanceForMint(owner: string, mint: string): Promise<bigint> {
    if (mint === RpcAccountReader.SOL_MINT) {
      const lamports = await this.rpcRequest<{ value: number }>("getBalance", [owner, { commitment: "confirmed" }]);
      return BigInt(lamports.value);
    }

    const tokenAccounts = await this.rpcRequest<{
      value: Array<{
        account: {
          data: {
            parsed?: {
              info?: {
                tokenAmount?: {
                  amount?: string;
                };
              };
            };
          };
        };
      }>;
    }>("getTokenAccountsByOwner", [
      owner,
      { mint },
      { encoding: "jsonParsed", commitment: "confirmed" }
    ]);

    return tokenAccounts.value?.reduce((sum, account) => {
      const amount = account.account.data.parsed?.info?.tokenAmount?.amount ?? "0";
      return sum + BigInt(amount);
    }, 0n) ?? 0n;
  }

  private async rpcRequest<T>(method: string, params: unknown[]): Promise<T> {
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
            method,
            params
          })
        });

        if (!response.ok) {
          const error = new Error(`RPC request ${method} failed with status ${response.status}`);
          if (isRecoverableRpcStatus(response.status) && attempt < this.rpcUrls.length - 1) {
            lastError = error;
            this.advanceRpcUrl();
            continue;
          }
          throw error;
        }

        const body = (await response.json()) as RpcResponse<T>;
        if (body.error) {
          throw new Error(`RPC request ${method} failed: ${body.error.message}`);
        }

        if (!body.result) {
          throw new Error(`RPC request ${method} returned an empty result`);
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

    throw lastError ?? new Error(`RPC request ${method} failed`);
  }

  private advanceRpcUrl() {
    this.currentRpcIndex = (this.currentRpcIndex + 1) % this.rpcUrls.length;
  }
}
