import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { writeAtomic } from './vault.js';
import type { WalletRecord } from '../types.js';
import type { ExecutionMode } from '../config.js';

/**
 * Flat-file store. The dataset here is a few hundred wallet rows at most, so a
 * JSON document held in memory and flushed atomically is both simpler and more
 * portable than a native SQLite build — no compiler toolchain needed on Windows.
 */

export interface Settings {
  slippagePercent: number;
  priorityFeeSol: number;
  executionMode: ExecutionMode;
  jitoTipSol: number;
  /** Wallet group currently targeted by batch actions. `null` = all wallets. */
  activeGroup: string | null;
  /** Default SOL per wallet for the quick-buy buttons. */
  quickBuyPresets: number[];
  /** Default sell percentages for the quick-sell buttons. */
  quickSellPresets: number[];
  /** Leave this much SOL behind when sweeping, to cover future fees. */
  sweepReserveSol: number;
  /**
   * 'auto' follows what recent blocks actually paid to touch the pump.fun
   * program; 'fixed' uses priorityFeeSol verbatim.
   */
  priorityFeeMode: 'fixed' | 'auto';
  /** Upper bound for auto mode, so a congestion spike cannot run away. */
  priorityFeeCeilingSol: number;
}

/**
 * What a position cost and what it has returned, accumulated across every batch.
 *
 * Kept per mint rather than per wallet: the operator runs fifty wallets as one
 * position, so "what did this token cost me" is the question worth answering.
 */
export interface PositionRecord {
  mint: string;
  symbol?: string;
  /** SOL committed to buys. Exact — it is what the batch was told to spend. */
  investedSol: number;
  /** SOL returned by sells, measured from balance deltas, so net of fees. */
  realisedSol: number;
  /** Wallet-fills, not batches. */
  buyFills: number;
  sellFills: number;
  firstBuyAt: number;
  lastTradeAt: number;
}

export interface TradeLogEntry {
  at: number;
  action: string;
  mint?: string;
  walletCount: number;
  succeeded: number;
  failed: number;
  note?: string;
}

interface DbShape {
  version: 1;
  wallets: WalletRecord[];
  settings: Settings;
  /** Encrypted mnemonic, if the operator generated an HD wallet set. */
  mnemonic?: string;
  tradeLog: TradeLogEntry[];
  positions: Record<string, PositionRecord>;
}

const defaultSettings = (): Settings => ({
  slippagePercent: config.trading.slippagePercent,
  priorityFeeSol: config.trading.priorityFeeSol,
  executionMode: config.trading.executionMode,
  jitoTipSol: config.trading.jitoTipSol,
  activeGroup: null,
  quickBuyPresets: [0.01, 0.05, 0.1, 0.5, 1],
  quickSellPresets: [25, 50, 75, 100],
  sweepReserveSol: 0.002,
  priorityFeeMode: 'auto',
  priorityFeeCeilingSol: 0.005,
});

const dbPath = () => path.join(config.dataDir, 'wallets.json');

let cache: DbShape | null = null;

function load(): DbShape {
  if (cache) return cache;

  if (!fs.existsSync(dbPath())) {
    cache = { version: 1, wallets: [], settings: defaultSettings(), tradeLog: [], positions: {} };
    return cache;
  }

  const parsed = JSON.parse(fs.readFileSync(dbPath(), 'utf8')) as Partial<DbShape>;

  // This bot was multi-chain once. A leftover EVM record would be handed to
  // Solana signing code that cannot use it, so drop those rather than let them
  // fail confusingly halfway through a batch.
  const stored = parsed.wallets ?? [];
  const wallets = stored.filter((w) => w.kind === 'solana');
  if (wallets.length !== stored.length) {
    console.warn(`Ignoring ${stored.length - wallets.length} non-Solana wallet record(s) from an older version.`);
  }

  cache = {
    version: 1,
    wallets,
    // merge so new settings keys added in later versions get sane defaults
    settings: { ...defaultSettings(), ...(parsed.settings ?? {}) },
    mnemonic: parsed.mnemonic,
    tradeLog: parsed.tradeLog ?? [],
    positions: parsed.positions ?? {},
  };
  return cache;
}

export function flush(): void {
  if (!cache) return;
  writeAtomic(dbPath(), JSON.stringify(cache, null, 2));
}

export const db = {
  wallets(): WalletRecord[] {
    return load().wallets;
  },

  setWallets(next: WalletRecord[]): void {
    load().wallets = next;
    flush();
  },

  settings(): Settings {
    return load().settings;
  },

  updateSettings(patch: Partial<Settings>): Settings {
    const s = load().settings;
    Object.assign(s, patch);
    flush();
    return s;
  },

  mnemonic(): string | undefined {
    return load().mnemonic;
  },

  setMnemonic(encrypted: string): void {
    load().mnemonic = encrypted;
    flush();
  },

  appendTradeLog(entry: TradeLogEntry): void {
    const d = load();
    d.tradeLog.unshift(entry);
    // keep the log bounded; this file is read fully into memory on boot
    if (d.tradeLog.length > 500) d.tradeLog.length = 500;
    flush();
  },

  tradeLog(limit = 20): TradeLogEntry[] {
    return load().tradeLog.slice(0, limit);
  },

  positions(): PositionRecord[] {
    return Object.values(load().positions);
  },

  position(mint: string): PositionRecord | undefined {
    return load().positions[mint];
  },

  /** Add a completed buy to the position's cost basis. */
  recordBuy(mint: string, solSpent: number, fills: number, symbol?: string): void {
    if (solSpent <= 0 || fills <= 0) return;
    const d = load();
    const now = Date.now();
    const pos = d.positions[mint] ?? {
      mint,
      symbol,
      investedSol: 0,
      realisedSol: 0,
      buyFills: 0,
      sellFills: 0,
      firstBuyAt: now,
      lastTradeAt: now,
    };

    pos.investedSol += solSpent;
    pos.buyFills += fills;
    pos.lastTradeAt = now;
    if (symbol && !pos.symbol) pos.symbol = symbol;

    d.positions[mint] = pos;
    flush();
  },

  /** Add sell proceeds. Positions with no recorded buy are still tracked. */
  recordSell(mint: string, solReceived: number, fills: number): void {
    if (solReceived <= 0 || fills <= 0) return;
    const d = load();
    const now = Date.now();
    const pos = d.positions[mint] ?? {
      mint,
      investedSol: 0,
      realisedSol: 0,
      buyFills: 0,
      sellFills: 0,
      firstBuyAt: now,
      lastTradeAt: now,
    };

    pos.realisedSol += solReceived;
    pos.sellFills += fills;
    pos.lastTradeAt = now;

    d.positions[mint] = pos;
    flush();
  },

  /** Escape hatch used by the passphrase-rotation flow. */
  raw(): DbShape {
    return load();
  },

  /**
   * Delete the wallet index and return to an empty store.
   *
   * The in-memory cache is reset too, so the running process forgets the old
   * wallets immediately rather than writing them back out on the next flush.
   */
  wipe(): void {
    fs.rmSync(dbPath(), { force: true });
    cache = { version: 1, wallets: [], settings: defaultSettings(), tradeLog: [], positions: {} };
  },
};
