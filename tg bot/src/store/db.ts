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
});

const dbPath = () => path.join(config.dataDir, 'wallets.json');

let cache: DbShape | null = null;

function load(): DbShape {
  if (cache) return cache;

  if (!fs.existsSync(dbPath())) {
    cache = { version: 1, wallets: [], settings: defaultSettings(), tradeLog: [] };
    return cache;
  }

  const parsed = JSON.parse(fs.readFileSync(dbPath(), 'utf8')) as Partial<DbShape>;
  cache = {
    version: 1,
    wallets: parsed.wallets ?? [],
    // merge so new settings keys added in later versions get sane defaults
    settings: { ...defaultSettings(), ...(parsed.settings ?? {}) },
    mnemonic: parsed.mnemonic,
    tradeLog: parsed.tradeLog ?? [],
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

  /** Escape hatch used by the passphrase-rotation flow. */
  raw(): DbShape {
    return load();
  },
};
