import { getSolBalances, getSplBalances, LAMPORTS } from '../chains/solana.js';
import { enabledChains, getNativeBalances, formatUnits } from '../chains/evm.js';
import { getSolanaPrices, getNativePrices, getSolPrice } from './prices.js';
import { selectWallets, mainWallet } from '../store/wallets.js';
import { errMessage, pMap } from '../util.js';
import { log } from '../logger.js';
import type { WalletRecord, WalletBalance, EvmChain, TokenBalance } from '../types.js';

/**
 * Portfolio aggregation across every wallet and chain.
 *
 * Balance reads are batched wherever the RPC allows it: one multicall per EVM
 * chain and one getMultipleAccounts per 100 Solana wallets. Token accounts still
 * need a call per wallet, so those run with bounded concurrency.
 */

export interface PortfolioTotals {
  solTotal: number;
  solUsd: number;
  evmTotals: Array<{ chain: EvmChain; symbol: string; amount: number; usd: number }>;
  tokenUsd: number;
  grandTotalUsd: number;
}

export interface Portfolio {
  solana: WalletBalance[];
  evm: Record<string, WalletBalance[]>;
  totals: PortfolioTotals;
  mainSolana?: { address: string; label: string; sol: number; usd: number };
  mainEvm?: { address: string; label: string };
  generatedAt: number;
  errors: string[];
}

export interface PortfolioOptions {
  group?: string | null;
  /** Token positions cost one RPC call per wallet — skip for a fast SOL-only view. */
  includeTokens?: boolean;
  includeEvm?: boolean;
}

export async function buildPortfolio(opts: PortfolioOptions = {}): Promise<Portfolio> {
  const includeTokens = opts.includeTokens ?? true;
  const includeEvm = opts.includeEvm ?? true;
  const errors: string[] = [];

  const solWallets = selectWallets({ kind: 'solana', group: opts.group, includeDisabled: true });
  const evmWallets = selectWallets({ kind: 'evm', group: opts.group, includeDisabled: true });

  const [solana, evm] = await Promise.all([
    loadSolana(solWallets, includeTokens, errors),
    includeEvm ? loadEvm(evmWallets, errors) : Promise.resolve({}),
  ]);

  const totals = await computeTotals(solana, evm, errors);

  const mainSol = mainWallet('solana');
  const mainSolBalance = mainSol ? solana.find((b) => b.walletId === mainSol.id) : undefined;
  const mainEvmWallet = mainWallet('evm');

  return {
    solana,
    evm,
    totals,
    mainSolana: mainSol
      ? {
          address: mainSol.address,
          label: mainSol.label,
          sol: mainSolBalance?.native ?? 0,
          usd: mainSolBalance?.nativeUsd ?? 0,
        }
      : undefined,
    mainEvm: mainEvmWallet ? { address: mainEvmWallet.address, label: mainEvmWallet.label } : undefined,
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

// ── EVM ───────────────────────────────────────────────────────────────────────

async function loadEvm(
  wallets: WalletRecord[],
  errors: string[],
): Promise<Record<string, WalletBalance[]>> {
  const out: Record<string, WalletBalance[]> = {};
  if (wallets.length === 0) return out;

  const chains = enabledChains();

  await Promise.all(
    chains.map(async (chain) => {
      try {
        const balances = await getNativeBalances(chain.key, wallets.map((w) => w.address));

        const rows: WalletBalance[] = wallets.map((w) => {
          const raw = balances.get(w.address as `0x${string}`) ?? balances.get(w.address) ?? 0n;
          return {
            walletId: w.id,
            address: w.address,
            label: w.label,
            chain: chain.key,
            native: Number(formatUnits(raw, 18)),
            nativeRaw: raw,
            tokens: [],
          };
        });

        // only report chains where something is actually held
        if (rows.some((r) => r.nativeRaw > 0n)) out[chain.key] = rows;
      } catch (err) {
        errors.push(`${chain.name}: ${errMessage(err)}`);
      }
    }),
  );

  return out;
}

// ── valuation ─────────────────────────────────────────────────────────────────

async function computeTotals(
  solana: WalletBalance[],
  evm: Record<string, WalletBalance[]>,
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

  const evmChainKeys = Object.keys(evm) as EvmChain[];
  let nativePrices = new Map<EvmChain, number>();
  if (evmChainKeys.length > 0) {
    try {
      nativePrices = await getNativePrices(evmChainKeys);
    } catch (err) {
      errors.push(`EVM prices: ${errMessage(err)}`);
    }
  }

  const evmTotals = evmChainKeys.map((key) => {
    const rows = evm[key] ?? [];
    const amount = rows.reduce((s, r) => s + r.native, 0);
    const price = nativePrices.get(key) ?? 0;
    const usd = amount * price;
    for (const r of rows) r.nativeUsd = r.native * price;

    const chain = enabledChains().find((c) => c.key === key);
    return { chain: key, symbol: chain?.symbol ?? '?', amount, usd };
  });

  const solUsd = solTotal * solPrice;
  const evmUsd = evmTotals.reduce((s, t) => s + t.usd, 0);

  return {
    solTotal,
    solUsd,
    evmTotals,
    tokenUsd,
    grandTotalUsd: solUsd + evmUsd + tokenUsd,
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
