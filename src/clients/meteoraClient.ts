import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction
} from "@solana/web3.js";
import { readFile } from "node:fs/promises";
import BN from "bn.js";

import type { Logger } from "pino";
import type { AppConfig, StrategyType } from "../config.js";
import type { ManagedPosition, PoolMetadata, PoolSnapshot, WalletBalances } from "../domain.js";
import { binIdToPrice, fromBaseUnits } from "../strategy/bins.js";
import { RpcAccountReader } from "../infra/rpcAccountReader.js";
import { JupiterClient } from "./jupiterClient.js";

export class InsufficientAllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientAllocationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface ClosePositionResult {
  withdrawnTokenA: bigint;
  withdrawnTokenB: bigint;
  feesTokenA: bigint;
  feesTokenB: bigint;
  txIds: string[];
}

export interface OpenPositionResult {
  positionAddress: string;
  lowerBinId: number;
  upperBinId: number;
  lowerPrice: number;
  upperPrice: number;
  txId: string | null;
}

export interface CompoundFeesResult {
  feesTokenA: bigint;
  feesTokenB: bigint;
  claimTxIds: string[];
  depositTxIds: string[];
}

export class MeteoraClient {
  private connection!: Connection;
  private wallet!: Keypair;
  private accountReader!: RpcAccountReader;
  private jupiterClient!: JupiterClient;
  private initialized = false;

  // Dynamic import of DLMM module (ESM)
  private DLMM: any;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {}

  async init(): Promise<void> {
    if (this.initialized) return;

    this.connection = new Connection(this.config.SOLANA_RPC_URL, "confirmed");
    this.accountReader = new RpcAccountReader(this.config.solanaRpcUrls);

    // Load wallet keypair
    const keypairData = JSON.parse(
      await readFile(this.config.BOT_WALLET_KEYPAIR_PATH, "utf8")
    ) as number[];
    this.wallet = Keypair.fromSecretKey(Uint8Array.from(keypairData));

    this.jupiterClient = new JupiterClient(
      this.connection,
      this.wallet,
      this.config.JUPITER_API_BASE_URL,
      this.config.JUPITER_API_KEY,
      this.logger
    );

    // Dynamic import of DLMM SDK
    const dlmmModule = await import("@meteora-ag/dlmm");
    this.DLMM = dlmmModule.default ?? dlmmModule;

    this.initialized = true;
    this.logger.info({ wallet: this.wallet.publicKey.toBase58() }, "meteora client initialized");
  }

  getOwnerAddress(): string {
    return this.wallet.publicKey.toBase58();
  }

  getJupiterClient(): JupiterClient {
    return this.jupiterClient;
  }

  async discoverPoolMetadata(poolAddress: string): Promise<PoolMetadata> {
    const dlmm = await this.createDlmmInstance(poolAddress);
    const tokenAMint = dlmm.tokenX.publicKey.toBase58();
    const tokenBMint = dlmm.tokenY.publicKey.toBase58();
    const binStep = dlmm.lbPair.binStep;

    const [tokenADecimals, tokenBDecimals] = await Promise.all([
      this.accountReader.getTokenDecimals(tokenAMint),
      this.accountReader.getTokenDecimals(tokenBMint)
    ]);

    // Derive symbols from known mints or use shortened mint
    const tokenASymbol = this.resolveTokenSymbol(tokenAMint);
    const tokenBSymbol = this.resolveTokenSymbol(tokenBMint);

    return {
      dlmmPoolAddress: poolAddress,
      binStep,
      tokenAMint,
      tokenASymbol,
      tokenADecimals,
      tokenBMint,
      tokenBSymbol,
      tokenBDecimals
    };
  }

  async fetchPoolSnapshot(poolAddress: string): Promise<PoolSnapshot> {
    const dlmm = await this.createDlmmInstance(poolAddress);
    const activeBin = await dlmm.getActiveBin();
    const activeBinId = activeBin.binId;
    const binStep = dlmm.lbPair.binStep;

    // activeBin.price is the raw lamport-level price. Convert to human-readable
    // by adjusting for token decimal difference (e.g. SOL 9 dec / USDC 6 dec = factor 1000).
    const decimalAdjust = dlmm.tokenX.mint.decimals - dlmm.tokenY.mint.decimals;
    const currentPrice = Number(activeBin.price) * Math.pow(10, decimalAdjust);

    return {
      dlmmPoolAddress: poolAddress,
      currentPrice,
      activeBinId,
      binStep,
      tokenAMint: dlmm.tokenX.publicKey.toBase58(),
      tokenBMint: dlmm.tokenY.publicKey.toBase58(),
      tokenADecimals: dlmm.tokenX.mint.decimals,
      tokenBDecimals: dlmm.tokenY.mint.decimals
    };
  }

  async getWalletBalances(tokenAMint: string, tokenBMint: string): Promise<WalletBalances> {
    return this.accountReader.getWalletBalances(
      this.wallet.publicKey.toBase58(),
      tokenAMint,
      tokenBMint
    );
  }

  async listPositions(poolAddress: string): Promise<ManagedPosition[]> {
    const dlmm = await this.createDlmmInstance(poolAddress);
    const { userPositions } = await dlmm.getPositionsByUserAndLbPair(this.wallet.publicKey);

    return (userPositions ?? []).map((pos: any) => ({
      positionAddress: pos.publicKey.toBase58(),
      dlmmPoolAddress: poolAddress,
      lowerBinId: pos.positionData.lowerBinId,
      upperBinId: pos.positionData.upperBinId,
      liquidity: BigInt(pos.positionData.totalXAmount?.toString() ?? "0") +
                 BigInt(pos.positionData.totalYAmount?.toString() ?? "0"),
      tokenAAmount: BigInt(pos.positionData.totalXAmount?.toString() ?? "0"),
      tokenBAmount: BigInt(pos.positionData.totalYAmount?.toString() ?? "0"),
      feeTokenA: BigInt(pos.positionData.feeX?.toString() ?? "0"),
      feeTokenB: BigInt(pos.positionData.feeY?.toString() ?? "0")
    }));
  }

  async listAllOwnerPositions(): Promise<ManagedPosition[]> {
    const positions = await this.DLMM.getAllLbPairPositionsByUser(
      this.connection,
      this.wallet.publicKey
    );

    const result: ManagedPosition[] = [];
    for (const [poolAddress, positionInfo] of positions) {
      for (const pos of positionInfo.lbPairPositionsData ?? []) {
        result.push({
          positionAddress: pos.publicKey.toBase58(),
          dlmmPoolAddress: poolAddress,
          lowerBinId: pos.positionData.lowerBinId,
          upperBinId: pos.positionData.upperBinId,
          liquidity: BigInt(pos.positionData.totalXAmount?.toString() ?? "0") +
                     BigInt(pos.positionData.totalYAmount?.toString() ?? "0"),
          tokenAAmount: BigInt(pos.positionData.totalXAmount?.toString() ?? "0"),
          tokenBAmount: BigInt(pos.positionData.totalYAmount?.toString() ?? "0"),
          feeTokenA: BigInt(pos.positionData.feeX?.toString() ?? "0"),
          feeTokenB: BigInt(pos.positionData.feeY?.toString() ?? "0")
        });
      }
    }

    return result;
  }

  async findManagedPosition(poolAddress: string, positionAddress: string): Promise<ManagedPosition | null> {
    const positions = await this.listPositions(poolAddress);
    return positions.find((p) => p.positionAddress === positionAddress) ?? null;
  }

  async closePosition(
    poolAddress: string,
    positionAddress: string,
    execute: boolean
  ): Promise<ClosePositionResult> {
    const dlmm = await this.createDlmmInstance(poolAddress);
    const positionPubkey = new PublicKey(positionAddress);

    // Get position data to determine bins with liquidity
    const { userPositions } = await dlmm.getPositionsByUserAndLbPair(this.wallet.publicKey);
    const position = (userPositions ?? []).find(
      (p: any) => p.publicKey.toBase58() === positionAddress
    );

    if (!position) {
      throw new Error(`Position ${positionAddress} not found`);
    }

    const txIds: string[] = [];
    let feesTokenA = 0n;
    let feesTokenB = 0n;

    if (!execute) {
      return {
        withdrawnTokenA: BigInt(position.positionData.totalXAmount?.toString() ?? "0"),
        withdrawnTokenB: BigInt(position.positionData.totalYAmount?.toString() ?? "0"),
        feesTokenA: BigInt(position.positionData.feeX?.toString() ?? "0"),
        feesTokenB: BigInt(position.positionData.feeY?.toString() ?? "0"),
        txIds: []
      };
    }

    // Step 1: Claim all fees
    try {
      const claimFeeTxs = await dlmm.claimAllRewards({
        owner: this.wallet.publicKey,
        positions: [position]
      });

      for (const tx of claimFeeTxs) {
        const txId = await this.sendAndConfirm(tx);
        txIds.push(txId);
      }

      feesTokenA = BigInt(position.positionData.feeX?.toString() ?? "0");
      feesTokenB = BigInt(position.positionData.feeY?.toString() ?? "0");
    } catch (error) {
      this.logger.warn({ error: (error as Error).message, positionAddress }, "fee claim failed, continuing with removal");
    }

    // Step 2: Remove all liquidity using fromBinId/toBinId range
    const lowerBinId = position.positionData.lowerBinId;
    const upperBinId = position.positionData.upperBinId;

    if (lowerBinId != null && upperBinId != null) {
      const removeLiqTxs = await dlmm.removeLiquidity({
        position: positionPubkey,
        user: this.wallet.publicKey,
        fromBinId: lowerBinId,
        toBinId: upperBinId,
        bps: new BN(10_000), // 100% removal
        shouldClaimAndClose: true
      });

      for (const tx of Array.isArray(removeLiqTxs) ? removeLiqTxs : [removeLiqTxs]) {
        const txId = await this.sendAndConfirm(tx);
        txIds.push(txId);
      }
    }

    // Close the position account to reclaim rent SOL (~0.057 SOL)
    try {
      const closeTx = await dlmm.closePositionIfEmpty({
        owner: this.wallet.publicKey,
        position
      });
      const closeTxId = await this.sendAndConfirm(closeTx);
      txIds.push(closeTxId);
      this.logger.info({ positionAddress, closeTxId }, "position account closed, rent reclaimed");
    } catch (e) {
      this.logger.warn(
        { positionAddress, error: (e as Error).message },
        "closePositionIfEmpty failed (position may not be fully empty)"
      );
    }

    const withdrawnTokenA = BigInt(position.positionData.totalXAmount?.toString() ?? "0");
    const withdrawnTokenB = BigInt(position.positionData.totalYAmount?.toString() ?? "0");

    this.logger.info(
      {
        positionAddress,
        withdrawnTokenA: withdrawnTokenA.toString(),
        withdrawnTokenB: withdrawnTokenB.toString(),
        txIds
      },
      "position closed"
    );

    return { withdrawnTokenA, withdrawnTokenB, feesTokenA, feesTokenB, txIds };
  }

  async openPosition(params: {
    poolAddress: string;
    lowerBinId: number;
    upperBinId: number;
    tokenAAmount: bigint;
    tokenBAmount: bigint;
    strategy: StrategyType;
    execute: boolean;
    deploymentBufferBps?: number;
  }): Promise<OpenPositionResult> {
    const dlmm = await this.createDlmmInstance(params.poolAddress);
    const binStep = dlmm.lbPair.binStep;
    const decimalAdjust = dlmm.tokenX.mint.decimals - dlmm.tokenY.mint.decimals;

    // Apply deployment buffer to reduce amounts slightly
    const bufferFactor = params.deploymentBufferBps
      ? (10_000 - params.deploymentBufferBps) / 10_000
      : 1;
    const tokenAAmount = BigInt(Math.floor(Number(params.tokenAAmount) * bufferFactor));
    const tokenBAmount = BigInt(Math.floor(Number(params.tokenBAmount) * bufferFactor));

    const lowerPrice = binIdToPrice(params.lowerBinId, binStep, decimalAdjust);
    const upperPrice = binIdToPrice(params.upperBinId, binStep, decimalAdjust);

    if (!params.execute) {
      return {
        positionAddress: "dry-run",
        lowerBinId: params.lowerBinId,
        upperBinId: params.upperBinId,
        lowerPrice,
        upperPrice,
        txId: null
      };
    }

    const positionKeypair = Keypair.generate();

    // Map strategy type to DLMM strategy parameters
    const strategyType = this.mapStrategyType(params.strategy);
    const binCount = params.upperBinId - params.lowerBinId + 1;

    const strategy = {
      maxBinId: params.upperBinId,
      minBinId: params.lowerBinId,
      strategyType
    };

    let lastTxId: string;

    if (binCount <= 70) {
      // Small range — single tx
      const createPositionTx = await dlmm.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: positionKeypair.publicKey,
        user: this.wallet.publicKey,
        totalXAmount: new BN(tokenAAmount.toString()),
        totalYAmount: new BN(tokenBAmount.toString()),
        strategy
      });
      lastTxId = await this.sendAndConfirm(createPositionTx, [positionKeypair]);
    } else {
      // Wide range — use multi-step: quote → create extended position → add liquidity
      this.logger.info({ binCount }, "wide range detected, using multi-tx position creation");

      const quote = await dlmm.quoteCreatePosition({ strategy });
      this.logger.info(
        { positionCount: quote.positionCount, txCount: quote.transactionCount },
        "position quote"
      );

      // Step 1: Create extended empty position that can hold all bins
      // Signature: createExtendedEmptyPosition(lowerBinId, upperBinId, position, owner)
      const createTxs = await dlmm.createExtendedEmptyPosition(
        params.lowerBinId,
        params.upperBinId,
        positionKeypair.publicKey,
        this.wallet.publicKey
      );
      for (const tx of Array.isArray(createTxs) ? createTxs : [createTxs]) {
        await this.sendAndConfirm(tx, [positionKeypair]);
      }
      this.logger.info("extended position created, adding liquidity");

      // Step 2: Add liquidity by strategy
      const addTxs = await dlmm.addLiquidityByStrategy({
        positionPubKey: positionKeypair.publicKey,
        user: this.wallet.publicKey,
        totalXAmount: new BN(tokenAAmount.toString()),
        totalYAmount: new BN(tokenBAmount.toString()),
        strategy
      });
      for (const tx of Array.isArray(addTxs) ? addTxs : [addTxs]) {
        lastTxId = await this.sendAndConfirm(tx);
      }
    }

    this.logger.info(
      {
        positionAddress: positionKeypair.publicKey.toBase58(),
        lowerBinId: params.lowerBinId,
        upperBinId: params.upperBinId,
        lowerPrice,
        upperPrice,
        tokenAAmount: tokenAAmount.toString(),
        tokenBAmount: tokenBAmount.toString(),
        strategy: params.strategy,
        binCount,
        txId: lastTxId!
      },
      "position opened"
    );

    return {
      positionAddress: positionKeypair.publicKey.toBase58(),
      lowerBinId: params.lowerBinId,
      upperBinId: params.upperBinId,
      lowerPrice,
      upperPrice,
      txId: lastTxId!
    };
  }

  async addLiquidityToBins(params: {
    poolAddress: string;
    positionAddress: string;
    lowerBinId: number;
    upperBinId: number;
    tokenAAmount: bigint;
    tokenBAmount: bigint;
    strategy: StrategyType;
  }): Promise<string[]> {
    const dlmm = await this.createDlmmInstance(params.poolAddress);
    const strategyType = this.mapStrategyType(params.strategy);

    const txs = await dlmm.addLiquidityByStrategy({
      positionPubKey: new PublicKey(params.positionAddress),
      user: this.wallet.publicKey,
      totalXAmount: new BN(params.tokenAAmount.toString()),
      totalYAmount: new BN(params.tokenBAmount.toString()),
      strategy: {
        maxBinId: params.upperBinId,
        minBinId: params.lowerBinId,
        strategyType
      }
    });

    const txIds: string[] = [];
    for (const tx of Array.isArray(txs) ? txs : [txs]) {
      const txId = await this.sendAndConfirm(tx);
      txIds.push(txId);
    }

    return txIds;
  }

  async claimAndCompoundFees(params: {
    poolAddress: string;
    positionAddress: string;
    lowerBinId: number;
    upperBinId: number;
    strategy: StrategyType;
  }): Promise<CompoundFeesResult> {
    const dlmm = await this.createDlmmInstance(params.poolAddress);
    const { userPositions } = await dlmm.getPositionsByUserAndLbPair(this.wallet.publicKey);
    const position = (userPositions ?? []).find(
      (p: any) => p.publicKey.toBase58() === params.positionAddress
    );

    if (!position) {
      throw new Error(`Position ${params.positionAddress} not found`);
    }

    const feesTokenA = BigInt(position.positionData.feeX?.toString() ?? "0");
    const feesTokenB = BigInt(position.positionData.feeY?.toString() ?? "0");

    if (feesTokenA === 0n && feesTokenB === 0n) {
      this.logger.info({ positionAddress: params.positionAddress }, "no fees to compound");
      return { feesTokenA: 0n, feesTokenB: 0n, claimTxIds: [], depositTxIds: [] };
    }

    // Step 1: Claim all fees
    const claimTxIds: string[] = [];
    const claimFeeTxs = await dlmm.claimAllRewards({
      owner: this.wallet.publicKey,
      positions: [position]
    });
    for (const tx of claimFeeTxs) {
      const txId = await this.sendAndConfirm(tx);
      claimTxIds.push(txId);
    }

    // Step 2: Deposit claimed fees back into the same position
    const depositTxIds: string[] = [];
    const strategyType = this.mapStrategyType(params.strategy);
    const depositTxs = await dlmm.addLiquidityByStrategy({
      positionPubKey: new PublicKey(params.positionAddress),
      user: this.wallet.publicKey,
      totalXAmount: new BN(feesTokenA.toString()),
      totalYAmount: new BN(feesTokenB.toString()),
      strategy: {
        maxBinId: params.upperBinId,
        minBinId: params.lowerBinId,
        strategyType
      }
    });
    for (const tx of Array.isArray(depositTxs) ? depositTxs : [depositTxs]) {
      const txId = await this.sendAndConfirm(tx);
      depositTxIds.push(txId);
    }

    this.logger.info(
      {
        positionAddress: params.positionAddress,
        feesTokenA: feesTokenA.toString(),
        feesTokenB: feesTokenB.toString(),
        claimTxIds,
        depositTxIds
      },
      "fees compounded"
    );

    return { feesTokenA, feesTokenB, claimTxIds, depositTxIds };
  }

  async removeLiquidityFromBins(params: {
    poolAddress: string;
    positionAddress: string;
    binIds: number[];
    bpsFraction: number;
  }): Promise<string[]> {
    const dlmm = await this.createDlmmInstance(params.poolAddress);

    const txs = await dlmm.removeLiquidity({
      position: new PublicKey(params.positionAddress),
      user: this.wallet.publicKey,
      binIds: params.binIds,
      bps: new BN(params.bpsFraction),
      shouldClaimAndClose: false
    });

    const txIds: string[] = [];
    for (const tx of Array.isArray(txs) ? txs : [txs]) {
      const txId = await this.sendAndConfirm(tx);
      txIds.push(txId);
    }

    return txIds;
  }

  async getSolUsdcPrice(): Promise<number | null> {
    try {
      const response = await fetch(
        `${this.config.JUPITER_API_BASE_URL}/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000000&swapMode=ExactIn&slippageBps=50`
      );
      if (!response.ok) return null;
      const data = (await response.json()) as { outAmount?: string };
      if (!data.outAmount) return null;
      return Number(data.outAmount) / 1_000_000;
    } catch {
      return null;
    }
  }

  private mapStrategyType(strategy: StrategyType): number {
    // DLMM SDK StrategyType is a numeric enum: Spot=0, Curve=1, BidAsk=2
    switch (strategy) {
      case "Spot":
        return 0;
      case "Curve":
        return 1;
      case "BidAsk":
        return 2;
      default:
        return 0;
    }
  }

  private async createDlmmInstance(poolAddress: string): Promise<any> {
    return this.DLMM.create(this.connection, new PublicKey(poolAddress));
  }

  private static readonly PRIORITY_FEE_MICROLAMPORTS = 50_000; // 50k microlamports/CU
  private static readonly MAX_RETRIES = 5;

  private async sendAndConfirm(transaction: any, additionalSigners: Keypair[] = []): Promise<string> {
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");

    const isLegacy = transaction.recentBlockhash !== undefined;
    const isVersioned = !isLegacy && transaction instanceof VersionedTransaction;

    if (isLegacy) {
      // Legacy Transaction: inject priority fee, set fresh blockhash, sign
      const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: MeteoraClient.PRIORITY_FEE_MICROLAMPORTS
      });
      transaction.add(priorityFeeIx);
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = this.wallet.publicKey;
      transaction.sign(this.wallet, ...additionalSigners);
    } else if (isVersioned) {
      // VersionedTransaction from SDK — rebuild with fresh blockhash + priority fee
      const rebuilt = await this.rebuildVersionedTx(transaction, blockhash, additionalSigners);
      transaction = rebuilt;
    } else if (typeof transaction.sign === "function") {
      // Fallback for other transaction-like objects
      transaction.sign([this.wallet, ...additionalSigners]);
    }

    const rawTransaction = transaction.serialize();
    const txId = await this.connection.sendRawTransaction(rawTransaction, {
      skipPreflight: false,
      maxRetries: MeteoraClient.MAX_RETRIES
    });

    await this.connection.confirmTransaction(
      { signature: txId, blockhash, lastValidBlockHeight },
      "confirmed"
    );

    return txId;
  }

  private async rebuildVersionedTx(
    tx: VersionedTransaction,
    blockhash: string,
    additionalSigners: Keypair[]
  ): Promise<VersionedTransaction> {
    // Decompile the message to get the instructions
    const message = tx.message;

    // Resolve address lookup tables if present
    const lookupTableKeys = message.addressTableLookups?.map(
      (lookup) => lookup.accountKey
    ) ?? [];
    const lookupTables = await Promise.all(
      lookupTableKeys.map(async (key) => {
        const result = await this.connection.getAddressLookupTable(key);
        return result.value;
      })
    );
    const validTables = lookupTables.filter(
      (t): t is NonNullable<typeof t> => t !== null
    );

    // Decompile to get original instructions
    const decompiledMessage = TransactionMessage.decompile(message, {
      addressLookupTableAccounts: validTables
    });

    // Check if priority fee already present
    const hasPriorityFee = decompiledMessage.instructions.some(
      (ix) => ix.programId.equals(ComputeBudgetProgram.programId) &&
        ix.data.length >= 5 && ix.data[0] === 3 // SetComputeUnitPrice discriminator
    );

    if (!hasPriorityFee) {
      decompiledMessage.instructions.unshift(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: MeteoraClient.PRIORITY_FEE_MICROLAMPORTS
        })
      );
    }

    // Rebuild with fresh blockhash
    decompiledMessage.recentBlockhash = blockhash;
    decompiledMessage.payerKey = this.wallet.publicKey;

    const newMessage = decompiledMessage.compileToV0Message(validTables);
    const newTx = new VersionedTransaction(newMessage);
    newTx.sign([this.wallet, ...additionalSigners]);

    return newTx;
  }

  private resolveTokenSymbol(mint: string): string {
    const knownTokens: Record<string, string> = {
      "So11111111111111111111111111111111111111112": "SOL",
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC",
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": "USDT",
      "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So": "mSOL",
      "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj": "stSOL",
      "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn": "JitoSOL",
      "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": "BONK",
      "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN": "JUP",
      "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": "ETH"
    };

    return knownTokens[mint] ?? `${mint.slice(0, 4)}...${mint.slice(-4)}`;
  }
}
