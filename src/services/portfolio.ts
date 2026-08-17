import { getSolBalances, getSplBalances, LAMPORTS } from '../chains/solana.js';
import { getSolanaPrices, getSolPrice } from './prices.js';
import { selectWallets, mainWallet } from '../store/wallets.js';
import { errMessage, pMap } from '../util.js';
import { log } from '../logger.js';
import type { WalletRecord, WalletBalance, TokenBalance } from '../types.js';

/**
 * Portfolio aggregation across every wallet.
 *
 * Balance reads are batched wherever the RPC allows it: one getMultipleAccounts
 * per 100 wallets. Token accounts still need a call per wallet, so those run
 * with bounded concurrency.
 */

export interface PortfolioTotals {
  solTotal: number;
  solUsd: number;
  tokenUsd: number;
  grandTotalUsd: number;
}

export interface Portfolio {
  solana: WalletBalance[];
  totals: PortfolioTotals;
  mainSolana?: { address: string; label: string; sol: number; usd: number };
  generatedAt: number;
  errors: string[];
}

export interface PortfolioOptions {
  group?: string | null;
  /** Token positions cost one RPC call per wallet — skip for a fast SOL-only view. */
  includeTokens?: boolean;
}

export async function buildPortfolio(opts: PortfolioOptions = {}): Promise<Portfolio> {
  const includeTokens = opts.includeTokens ?? true;
  const errors: string[] = [];

  const solWallets = selectWallets({ group: opts.group, includeDisabled: true });
  const solana = await loadSolana(solWallets, includeTokens, errors);
  const totals = await computeTotals(solana, errors);

  const mainSol = mainWallet();
  const mainSolBalance = mainSol ? solana.find((b) => b.walletId === mainSol.id) : undefined;

  return {
    solana,
    totals,
    mainSolana: mainSol
      ? {
          address: mainSol.address,
          label: mainSol.label,
          sol: mainSolBalance?.native ?? 0,
          usd: mainSolBalance?.nativeUsd ?? 0,
        }
      : undefined,
    generatedAt: Date.now(),
    errors,
  };
}

// ── Solana ────────────────────────────────────────────────────────────────────

async function loadSolana(
  wallets: WalletRecord[],
  includeTokens: boolean,
  errors: string[],
): Promise<WalletBalance[]> {
  if (wallets.length === 0) return [];

  let lamportsByAddress = new Map<string, bigint>();
  try {
    lamportsByAddress = await getSolBalances(wallets.map((w) => w.address));
  } catch (err) {
    errors.push(`Solana balances: ${errMessage(err)}`);
  }

  const balances: WalletBalance[] = wallets.map((w) => {
    const lamports = lamportsByAddress.get(w.address) ?? 0n;
    return {
      walletId: w.id,
      address: w.address,
      label: w.label,
      chain: 'solana',
      native: Number(lamports) / LAMPORTS,
      nativeRaw: lamports,
      tokens: [],
    };
  });

  if (!includeTokens) return balances;

  // one getParsedTokenAccountsByOwner per wallet — the expensive part
  await pMap(balances, 5, async (b) => {
    try {
      b.tokens = await getSplBalances(b.address);
    } catch (err) {
      b.error = errMessage(err);
    }
  });

  return balances;
}

// ── valuation ─────────────────────────────────────────────────────────────────

async function computeTotals(
  solana: WalletBalance[],
  errors: string[],
): Promise<PortfolioTotals> {
  const solTotal = solana.reduce((s, b) => s + b.native, 0);

  let solPrice = 0;
  try {
    solPrice = await getSolPrice();
  } catch (err) {
    errors.push(`SOL price: ${errMessage(err)}`);
  }

  for (const b of solana) b.nativeUsd = b.native * solPrice;

  // price every distinct SPL mint held anywhere in the set, in one batch
  const mints = new Set<string>();
  for (const b of solana) for (const t of b.tokens) mints.add(t.mint);

  let tokenUsd = 0;
  if (mints.size > 0) {
    try {
      const prices = await getSolanaPrices([...mints]);
      for (const b of solana) {
        for (const t of b.tokens) {
          const p = prices.get(t.mint);
          if (p !== undefined) {
            t.usdValue = t.amount * p;
            tokenUsd += t.usdValue;
          }
        }
      }
    } catch (err) {
      log.warn('Token pricing failed', err);
    }
  }

  const solUsd = solTotal * solPrice;

  return {
    solTotal,
    solUsd,
    tokenUsd,
    grandTotalUsd: solUsd + tokenUsd,
  };
}

/** Aggregate one token across every wallet — used by the position screens. */
export function aggregateToken(portfolio: Portfolio, mint: string): {
  totalAmount: number;
  totalUsd: number;
  holders: Array<{ label: string; address: string; amount: number; usd?: number }>;
} {
  const holders: Array<{ label: string; address: string; amount: number; usd?: number }> = [];
  let totalAmount = 0;
  let totalUsd = 0;

  for (const b of portfolio.solana) {
    const t = b.tokens.find((x) => x.mint === mint);
    if (!t || t.amount === 0) continue;
    holders.push({ label: b.label, address: b.address, amount: t.amount, usd: t.usdValue });
    totalAmount += t.amount;
    totalUsd += t.usdValue ?? 0;
  }

  holders.sort((a, b) => b.amount - a.amount);
  return { totalAmount, totalUsd, holders };
}

/** Every distinct token position held across the wallet set, largest first. */
export function listPositions(portfolio: Portfolio): Array<{
  mint: string;
  symbol: string;
  totalAmount: number;
  totalUsd: number;
  walletCount: number;
}> {
  const map = new Map<string, { symbol: string; totalAmount: number; totalUsd: number; walletCount: number }>();

  for (const b of portfolio.solana) {
    for (const t of b.tokens) {
      const entry = map.get(t.mint) ?? { symbol: t.symbol, totalAmount: 0, totalUsd: 0, walletCount: 0 };
      entry.totalAmount += t.amount;
      entry.totalUsd += t.usdValue ?? 0;
      entry.walletCount += 1;
      map.set(t.mint, entry);
    }
  }

  return [...map.entries()]
    .map(([mint, v]) => ({ mint, ...v }))
    .sort((a, b) => b.totalUsd - a.totalUsd || b.totalAmount - a.totalAmount);
}

export type { TokenBalance };
