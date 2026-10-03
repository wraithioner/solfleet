import type { BuyEntry } from '../store/db.js';
import type { BatchSummary, ExecutionResult } from '../types.js';

export interface FillClassification {
  filled: ExecutionResult[];
  fills: number;
  uncertain: boolean;
}

/** Idle wallets and unresolved submissions must never count as confirmed fills. */
export function classifyFills(summary: Pick<BatchSummary, 'results'>): FillClassification {
  const filled = summary.results.filter(result => result.ok && result.signature);
  return {
    filled,
    fills: filled.length,
    uncertain: summary.results.some(result => result.confirmationUnknown),
  };
}

type TokenMeasurement = (
  addresses: string[],
  mint: string,
  before: Map<string, bigint> | undefined,
  decimals: number | undefined,
) => Promise<number>;

interface MeasuredFill {
  mint: string;
  summary: BatchSummary;
  before: Map<string, bigint> | undefined;
  decimals: number | undefined;
}

export interface MeasuredBuy extends MeasuredFill {
  solPerWallet: number;
  symbol?: string;
}

export interface BuyAccountingServices {
  ledger: {
    invalidateBasis(mint: string): void;
    recordBuy(mint: string, entry: BuyEntry): void;
  };
  measureTokensGained: TokenMeasurement;
}

export interface SellAccountingServices {
  ledger: {
    invalidateBasis(mint: string): void;
    recordSell(mint: string, solReceived: number, fills: number, tokensSold?: number): void;
  };
  measureTokensSold: TokenMeasurement;
}

/** An unreadable pre-trade balance cannot establish that an existing basis is closed. */
export function isFreshEntry(before: Map<string, bigint> | undefined): boolean {
  return before !== undefined && ![...before.values()].some(balance => balance > 0n);
}

/**
 * Book only confirmed purchases, retaining incomplete quantities when another
 * submission may still land. Execution, authorization and retries stay with
 * the caller; measurements and persistence are injected for behavior tests.
 */
export async function recordMeasuredBuy(
  buy: MeasuredBuy,
  services: BuyAccountingServices,
): Promise<FillClassification & { tokensBought: number }> {
  const classification = classifyFills(buy.summary);
  if (classification.uncertain) services.ledger.invalidateBasis(buy.mint);
  if (classification.fills === 0) return { ...classification, tokensBought: 0 };

  const tokensBought =
    buy.decimals === undefined
      ? 0
      : await services.measureTokensGained(
          classification.filled.map(result => result.address),
          buy.mint,
          buy.before,
          buy.decimals,
        );
  services.ledger.recordBuy(buy.mint, {
    solSpent: buy.solPerWallet * classification.fills,
    fills: classification.fills,
    tokensBought,
    symbol: buy.symbol,
    costSol: buy.summary.solSpent,
    freshEntry: isFreshEntry(buy.before),
    decimals: buy.decimals,
    quantityComplete: !classification.uncertain,
  });
  return { ...classification, tokensBought };
}

/**
 * Book measured proceeds and quantity without attributing unresolved changes to
 * the confirmed sale. Take a position snapshot before calling this if its
 * pre-sale basis is needed for an exit notification: recording mutates it.
 */
export async function recordMeasuredSell(
  sell: MeasuredFill,
  services: SellAccountingServices,
): Promise<FillClassification & { tokensSold: number }> {
  const classification = classifyFills(sell.summary);
  if (classification.uncertain) services.ledger.invalidateBasis(sell.mint);
  if (classification.fills === 0) return { ...classification, tokensSold: 0 };

  const tokensSold = await services.measureTokensSold(
    classification.filled.map(result => result.address),
    sell.mint,
    sell.before,
    sell.decimals,
  );
  services.ledger.recordSell(
    sell.mint,
    sell.summary.solReceived ?? 0,
    classification.fills,
    classification.uncertain ? undefined : tokensSold || undefined,
  );
  return { ...classification, tokensSold };
}
