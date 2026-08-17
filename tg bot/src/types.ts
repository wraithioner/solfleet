export type Chain = 'solana' | 'ethereum' | 'base' | 'arbitrum' | 'bsc' | 'polygon' | 'optimism';

export const EVM_CHAINS = ['ethereum', 'base', 'arbitrum', 'bsc', 'polygon', 'optimism'] as const;
export type EvmChain = (typeof EVM_CHAINS)[number];

export function isEvmChain(c: Chain): c is EvmChain {
  return (EVM_CHAINS as readonly string[]).includes(c);
}

/**
 * A wallet record as stored on disk. `secret` is the ciphertext blob produced by
 * the vault — the plaintext private key is never persisted and never leaves
 * memory once decrypted.
 */
export interface WalletRecord {
  id: string;
  kind: 'solana' | 'evm';
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
