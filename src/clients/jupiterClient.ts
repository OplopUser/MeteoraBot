import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction
} from "@solana/web3.js";

import type { Logger } from "pino";

export interface JupiterSwapResult {
  txId: string | null;
  inputMint: string;
  outputMint: string;
  inputAmount: string;
  outputAmount: string;
  feeLamports: number;
}

interface JupiterQuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  routePlan: unknown[];
}

interface JupiterSwapInstructionsResponse {
  setupInstructions?: InstructionPayload[];
  swapInstruction: InstructionPayload;
  cleanupInstruction?: InstructionPayload;
  addressLookupTableAddresses?: string[];
}

interface InstructionPayload {
  programId: string;
  accounts: Array<{
    pubkey: string;
    isSigner: boolean;
    isWritable: boolean;
  }>;
  data: string;
}

export class JupiterClient {
  private static readonly RATE_LIMIT_RETRIES = 3;
  private static readonly RATE_LIMIT_BACKOFF_MS = 1_500;
  private static readonly CONFIRMATION_TIMEOUT_MS = 45_000;

  constructor(
    private readonly connection: Connection,
    private readonly wallet: Keypair,
    private readonly apiBaseUrl: string,
    private readonly apiKey: string,
    private readonly logger: Logger
  ) {}

  async swap(params: {
    inputMint: string;
    outputMint: string;
    amount: string;
    swapMode: "ExactIn" | "ExactOut";
    slippageBps: number;
    execute: boolean;
  }): Promise<JupiterSwapResult> {
    const quote = await this.fetchQuote(
      params.inputMint,
      params.outputMint,
      params.amount,
      params.swapMode,
      params.slippageBps
    );

    this.logger.info(
      {
        inputMint: quote.inputMint,
        outputMint: quote.outputMint,
        inAmount: quote.inAmount,
        outAmount: quote.outAmount,
        slippageBps: quote.slippageBps
      },
      "jupiter quote received"
    );

    if (!params.execute) {
      return {
        txId: null,
        inputMint: quote.inputMint,
        outputMint: quote.outputMint,
        inputAmount: quote.inAmount,
        outputAmount: quote.outAmount,
        feeLamports: 0
      };
    }

    const swapInstructions = await this.fetchSwapInstructions(quote);
    const txId = await this.sendSwapTransaction(swapInstructions);

    return {
      txId,
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      inputAmount: quote.inAmount,
      outputAmount: quote.outAmount,
      feeLamports: 0
    };
  }

  private async fetchQuote(
    inputMint: string,
    outputMint: string,
    amount: string,
    swapMode: string,
    slippageBps: number
  ): Promise<JupiterQuoteResponse> {
    const url = new URL(`${this.apiBaseUrl}/quote`);
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", amount);
    url.searchParams.set("swapMode", swapMode);
    url.searchParams.set("slippageBps", String(slippageBps));
    url.searchParams.set("onlyDirectRoutes", "false");

    return this.fetchWithRetry<JupiterQuoteResponse>(url.toString());
  }

  private async fetchSwapInstructions(quote: JupiterQuoteResponse): Promise<JupiterSwapInstructionsResponse> {
    const url = `${this.apiBaseUrl}/swap-instructions`;
    const body = {
      quoteResponse: quote,
      userPublicKey: this.wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      useSharedAccounts: true,
      prioritizationFeeLamports: "auto"
    };

    return this.fetchWithRetry<JupiterSwapInstructionsResponse>(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  private async sendSwapTransaction(swapInstructions: JupiterSwapInstructionsResponse): Promise<string> {
    const instructions: TransactionInstruction[] = [];

    for (const ix of swapInstructions.setupInstructions ?? []) {
      instructions.push(this.deserializeInstruction(ix));
    }

    instructions.push(this.deserializeInstruction(swapInstructions.swapInstruction));

    if (swapInstructions.cleanupInstruction) {
      instructions.push(this.deserializeInstruction(swapInstructions.cleanupInstruction));
    }

    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");

    const addressLookupTableAccounts = await this.resolveAddressLookupTables(
      swapInstructions.addressLookupTableAddresses ?? []
    );

    const messageV0 = new TransactionMessage({
      payerKey: this.wallet.publicKey,
      recentBlockhash: blockhash,
      instructions
    }).compileToV0Message(addressLookupTableAccounts);

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([this.wallet]);

    const txId = await this.connection.sendTransaction(transaction, {
      skipPreflight: false,
      maxRetries: 5
    });

    await this.connection.confirmTransaction(
      { signature: txId, blockhash, lastValidBlockHeight },
      "confirmed"
    );

    this.logger.info({ txId }, "jupiter swap confirmed");
    return txId;
  }

  private deserializeInstruction(ix: InstructionPayload): TransactionInstruction {
    return {
      programId: new PublicKey(ix.programId),
      keys: ix.accounts.map((account) => ({
        pubkey: new PublicKey(account.pubkey),
        isSigner: account.isSigner,
        isWritable: account.isWritable
      })),
      data: Buffer.from(ix.data, "base64")
    };
  }

  private async resolveAddressLookupTables(addresses: string[]) {
    if (!addresses.length) {
      return [];
    }

    const results = await Promise.all(
      addresses.map(async (address) => {
        const account = await this.connection.getAddressLookupTable(new PublicKey(address));
        return account.value;
      })
    );

    return results.filter((table): table is NonNullable<typeof table> => table !== null);
  }

  private async fetchWithRetry<T>(url: string, init?: RequestInit): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= JupiterClient.RATE_LIMIT_RETRIES; attempt += 1) {
      if (attempt > 0) {
        await this.sleep(JupiterClient.RATE_LIMIT_BACKOFF_MS * attempt);
      }

      try {
        const headers: Record<string, string> = {
          ...(init?.headers as Record<string, string> | undefined)
        };
        if (this.apiKey) {
          headers["x-api-key"] = this.apiKey;
        }

        const response = await fetch(url, { ...init, headers });

        if (response.status === 429) {
          lastError = new Error("Jupiter API rate limited (429)");
          continue;
        }

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new Error(`Jupiter API error ${response.status}: ${text}`);
        }

        return (await response.json()) as T;
      } catch (error) {
        if ((error as Error).message?.includes("429") && attempt < JupiterClient.RATE_LIMIT_RETRIES) {
          lastError = error as Error;
          continue;
        }
        throw error;
      }
    }

    throw lastError ?? new Error("Jupiter API request failed");
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
