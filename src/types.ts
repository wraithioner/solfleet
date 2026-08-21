/**
 * Chains a *token lookup* can report. The bot holds wallets and trades on
 * Solana only; the rest exist because pasting a contract address from another
 * chain should still return an honest, clearly-labelled research card rather
 * than "unknown token".
 */
export type Chain = 'solana' | 'ethereum' | 'base' | 'arbitrum' | 'bsc' | 'polygon' | 'optimism';

/**
 * A wallet record as stored on disk. `secret` is the ciphertext blob produced by
 * the vault — the plaintext private key is never persisted and never leaves
 * memory once decrypted.
 */
export interface WalletRecord {
  id: string;
  kind: 'solana';
  address: string;
  label: string;
  /** Encrypted private key / keypair bytes. */
  secret: string;
  /** Freeform tags used for grouping, e.g. "snipers", "batch-a". */
  groups: string[];
  /** The one wallet funds get consolidated into. Exactly one per kind. */
  isMain: boolean;
  /** Excluded from batch operations while true. */
  disabled: boolean;
  /** HD derivation index, if this wallet came from a mnemonic. */
  derivationIndex?: number;
  createdAt: number;
}

/**
 * A wallet written by the multi-chain version of this bot, before it became
 * Solana-only. Nothing in here can sign — the record exists so the operator can
 * get the key out, since it may still hold funds on the chain it came from.
 */
export type LegacyWalletRecord = Omit<WalletRecord, 'kind'> & { kind: string };

export interface TokenBalance {
  mint: string;
  symbol: string;
  amount: number;
  decimals: number;
  rawAmount: bigint;
  usdValue?: number;
}

export interface WalletBalance {
  walletId: string;
  address: string;
  label: string;
  chain: Chain;
  /** Native coin balance in whole units (SOL / ETH / BNB ...). */
  native: number;
  nativeRaw: bigint;
  nativeUsd?: number;
  tokens: TokenBalance[];
  error?: string;
}

export interface ExecutionResult {
  walletId: string;
  label: string;
  address: string;
  ok: boolean;
  signature?: string;
  txHash?: string;
  error?: string;
  /** Populated for trades: how much was actually spent/received. */
  detail?: string;
}

export interface BatchSummary {
  results: ExecutionResult[];
  succeeded: number;
  failed: number;
  startedAt: number;
  finishedAt: number;
  /**
   * SOL that actually left the wallets, measured across the whole batch.
   *
   * The requested trade size is not what a buy costs. Priority fees, a Jito
   * tip, the rent on a token account the first buy has to open — none of that
   * appears in the amount the operator typed, and all of it is money gone.
   * Undefined when the balances could not be read on both sides, because a
   * half-measured cost is worse than an admittedly missing one.
   */
  solSpent?: number;
  /**
   * SOL that came back from a batch of sells, measured the same way.
   *
   * Net of fees, so it is what actually arrived. Undefined when the balances
   * could not be read on both sides.
   */
  solReceived?: number;
}

export type TradeAction = 'buy' | 'sell';

export interface TradeRequest {
  action: TradeAction;
  mint: string;
  /** For buys: SOL per wallet. For sells: percentage of held tokens (1-100). */
  amount: number;
  denominatedInSol: boolean;
  slippagePercent: number;
  priorityFeeSol: number;
  pool: 'pump' | 'raydium' | 'pump-amm' | 'launchlab' | 'raydium-cpmm' | 'bonk' | 'auto';
}
