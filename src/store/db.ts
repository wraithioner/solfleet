import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { writeAtomic } from './vault.js';
import type { WalletRecord, LegacyWalletRecord } from '../types.js';
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
  /** Whole tokens acquired, measured from balance deltas. */
  tokensBought: number;
  firstBuyAt: number;
  lastTradeAt: number;
}

/**
 * A standing instruction the watcher evaluates against live prices.
 *
 * Rules are stored rather than held in memory so a redeploy cannot silently
 * drop a stop-loss the operator is relying on — the one kind of forgetting that
 * costs money while nobody is looking.
 */
export interface AutoRule {
  id: string;
  mint: string;
  symbol?: string;
  kind: 'take_profit' | 'stop_loss' | 'trailing_stop' | 'limit_buy' | 'limit_sell';
  /**
   * For TP/SL: percentage from the recorded entry. For a trailing stop: how far
   * below the peak. Limit orders ignore it and use triggerPriceSol instead.
   */
  triggerPct: number;
  /**
   * Absolute price in SOL for limit orders. Set when the rule is created from a
   * percentage off the price at that moment, so the target cannot drift.
   */
  triggerPriceSol?: number;
  /** How much of the holding to sell when a selling rule fires. */
  sellPercent: number;
  /** SOL per wallet when a limit buy fires. */
  buySol?: number;
  /** For trailing stops: the highest price seen since the rule was created. */
  peakPriceSol?: number;
  enabled: boolean;
  createdAt: number;
  firedAt?: number;
}

/**
 * A wallet whose trades this bot mirrors.
 *
 * `copiedMints` is the guard that matters: without it, a target that scales
 * into a position over twenty transactions would drag the operator into twenty
 * separate buys. One copy per token per target, unless the operator resets it.
 */
/**
 * How a copied buy is sized.
 *
 * `fixed` spends the same amount every time, whatever they risked. `percent`
 * scales with their conviction — a trader's 10 SOL entry and their 0.5 SOL
 * nibble are not the same signal, and copying both at one size throws that
 * information away.
 */
export type CopySizeMode = 'fixed' | 'percent';

/**
 * Whether to follow a trader averaging into a position.
 *
 * `first` takes their opening buy and ignores the rest, so a trader scaling in
 * over twenty transactions costs one entry. `every` averages in alongside them,
 * bounded by `maxEntries` because the alternative is an open-ended commitment
 * decided by somebody else's wallet.
 */
export type CopyEntryMode = 'first' | 'every';

/**
 * What to do when they sell.
 *
 * `proportional` mirrors the share they sold — a 10% trim is copied as a 10%
 * trim. `all` exits completely the first time they take anything off, which is
 * the safer read of a trader who trims before dumping. `off` leaves exits to
 * your own take-profit and stop-loss rules.
 */
export type CopyExitMode = 'proportional' | 'all' | 'off';

export interface CopyTarget {
  id: string;
  address: string;
  label: string;
  /**
   * SOL per wallet when `sizeMode` is `fixed`. Kept as the field name it has
   * always had so existing followed wallets load unchanged.
   */
  buySol: number;
  sizeMode: CopySizeMode;
  /**
   * Share of the SOL they spent, when `sizeMode` is `percent`. Applied to the
   * batch as a whole and then divided across the wallets, so "5%" means your
   * copy is 5% the size of their trade — not 5% times however many wallets you
   * happen to have running.
   */
  sizePercent: number;
  entryMode: CopyEntryMode;
  /** Cap on copied buys per token in `every` mode. */
  maxEntries: number;
  exitMode: CopyExitMode;
  /**
   * Armed automatically on every position this target opens.
   *
   * `exitMode` follows the trader out; these leave on their own terms. A copy
   * lands seconds behind the wallet it follows, so waiting for their exit means
   * taking it at a worse price than they did — a target of your own is the only
   * exit that does not depend on somebody else's timing.
   *
   * Undefined means no rule is armed, which is not the same as zero.
   */
  takeProfitPct?: number;
  stopLossPct?: number;
  /** Share of the position a fired take-profit sells. Stops always exit fully. */
  takeProfitSellPct?: number;
  /** @deprecated Superseded by exitMode; retained so old records still load. */
  copySells?: boolean;
  enabled: boolean;
  /** Newest signature already processed, so a restart does not replay history. */
  lastSignature?: string;
  /** Mints already copied from this target. */
  copiedMints: string[];
  /** Copied buys so far per mint, for the `every` cap. */
  entryCounts?: Record<string, number>;
  createdAt: number;
}

/**
 * A recurring buy, spread over time rather than placed in one go.
 *
 * The point of averaging in is that no single entry decides the position, so a
 * plan carries the number of rounds it has left and stops on its own — an
 * automation that buys forever is a way to lose money slowly while believing
 * you have a strategy.
 */
export interface DcaPlan {
  id: string;
  mint: string;
  symbol?: string;
  /** SOL per wallet, per round. */
  buySol: number;
  intervalMinutes: number;
  roundsTotal: number;
  roundsDone: number;
  nextRunAt: number;
  enabled: boolean;
  createdAt: number;
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
  rules: AutoRule[];
  copyTargets: CopyTarget[];
  dcaPlans: DcaPlan[];
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

/**
 * Fill in the fields a followed wallet gained after it was saved.
 *
 * The defaults reproduce exactly what the old code did — one fixed-size entry
 * per token, exits mirrored proportionally — so upgrading never silently
 * changes how an existing target trades.
 */
function migrateCopyTarget(t: CopyTarget): CopyTarget {
  return {
    ...t,
    sizeMode: t.sizeMode ?? 'fixed',
    sizePercent: t.sizePercent ?? 5,
    entryMode: t.entryMode ?? 'first',
    maxEntries: t.maxEntries ?? 3,
    exitMode: t.exitMode ?? (t.copySells === false ? 'off' : 'proportional'),
    entryCounts: t.entryCounts ?? {},
    takeProfitSellPct: t.takeProfitSellPct ?? 50,
  };
}

function load(): DbShape {
  if (cache) return cache;

  if (!fs.existsSync(dbPath())) {
    cache = { version: 1, wallets: [], settings: defaultSettings(), tradeLog: [], positions: {}, rules: [], copyTargets: [], dcaPlans: [] };
    return cache;
  }

  const parsed = JSON.parse(fs.readFileSync(dbPath(), 'utf8')) as Partial<DbShape>;

  /*
   * This bot was multi-chain once, and a wallets.json written then can still
   * hold EVM records. They are kept in the document, NOT filtered out of it:
   * dropping them here and then flushing would write the file back without
   * them, permanently destroying encrypted keys that may still hold funds.
   * `db.wallets()` filters at the point of use instead, so Solana signing code
   * never sees one.
   */
  const wallets = parsed.wallets ?? [];
  const legacy = wallets.filter((w) => w.kind !== 'solana').length;
  if (legacy > 0) {
    console.warn(`${legacy} wallet(s) from the multi-chain version are preserved but inactive. Settings → Export legacy keys.`);
  }

  cache = {
    version: 1,
    wallets,
    // merge so new settings keys added in later versions get sane defaults
    settings: { ...defaultSettings(), ...(parsed.settings ?? {}) },
    mnemonic: parsed.mnemonic,
    tradeLog: parsed.tradeLog ?? [],
    positions: parsed.positions ?? {},
    rules: parsed.rules ?? [],
    copyTargets: (parsed.copyTargets ?? []).map(migrateCopyTarget),
    dcaPlans: parsed.dcaPlans ?? [],
  };
  return cache;
}

export function flush(): void {
  if (!cache) return;
  writeAtomic(dbPath(), JSON.stringify(cache, null, 2));
}

export const db = {
  wallets(): WalletRecord[] {
    return load().wallets.filter((w) => w.kind === 'solana');
  },

  /** Records from the multi-chain era: kept on disk, excluded from trading. */
  legacyWallets(): LegacyWalletRecord[] {
    const all = load().wallets as unknown as LegacyWalletRecord[];
    return all.filter((w) => w.kind !== 'solana');
  },

  /**
   * Delete the multi-chain records for good. Only reachable from the screen
   * that hands the keys over first.
   */
  dropLegacyWallets(): number {
    const doc = load();
    const before = doc.wallets.length;
    doc.wallets = doc.wallets.filter((w) => w.kind === 'solana');
    flush();
    return before - doc.wallets.length;
  },

  /**
   * Append a wallet to the stored list.
   *
   * `wallets()` returns a filtered copy, so pushing onto its result would add
   * the wallet to an array nobody keeps — this is the only way in.
   */
  addWallet(record: WalletRecord): void {
    load().wallets.push(record);
    flush();
  },

  setWallets(next: WalletRecord[]): void {
    // preserve anything this version does not manage, rather than truncating it
    const legacy = db.legacyWallets() as unknown as WalletRecord[];
    load().wallets = [...next, ...legacy];
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
  recordBuy(mint: string, solSpent: number, fills: number, tokensBought = 0, symbol?: string): void {
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
      tokensBought: 0,
      firstBuyAt: now,
      lastTradeAt: now,
    };

    pos.investedSol += solSpent;
    pos.buyFills += fills;
    pos.tokensBought += tokensBought;
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
      tokensBought: 0,
      firstBuyAt: now,
      lastTradeAt: now,
    };

    pos.realisedSol += solReceived;
    pos.sellFills += fills;
    pos.lastTradeAt = now;

    d.positions[mint] = pos;
    flush();
  },

  rules(): AutoRule[] {
    return load().rules;
  },

  activeRules(): AutoRule[] {
    return load().rules.filter((r) => r.enabled && !r.firedAt);
  },

  rulesFor(mint: string): AutoRule[] {
    return load().rules.filter((r) => r.mint === mint && r.enabled && !r.firedAt);
  },

  addRule(rule: AutoRule): void {
    load().rules.push(rule);
    flush();
  },

  updateRule(id: string, patch: Partial<AutoRule>): void {
    const rule = load().rules.find((r) => r.id === id);
    if (!rule) return;
    Object.assign(rule, patch);
    flush();
  },

  removeRule(id: string): void {
    const d = load();
    d.rules = d.rules.filter((r) => r.id !== id);
    flush();
  },

  copyTargets(): CopyTarget[] {
    return load().copyTargets;
  },

  activeCopyTargets(): CopyTarget[] {
    return load().copyTargets.filter((t) => t.enabled);
  },

  addCopyTarget(target: CopyTarget): void {
    load().copyTargets.push(target);
    flush();
  },

  updateCopyTarget(id: string, patch: Partial<CopyTarget>): void {
    const t = load().copyTargets.find((x) => x.id === id);
    if (!t) return;
    Object.assign(t, patch);
    flush();
  },

  removeCopyTarget(id: string): void {
    const d = load();
    d.copyTargets = d.copyTargets.filter((t) => t.id !== id);
    flush();
  },

  dcaPlans(): DcaPlan[] {
    return load().dcaPlans;
  },

  /** Plans that are enabled, still have rounds left, and are due. */
  dueDcaPlans(now = Date.now()): DcaPlan[] {
    return load().dcaPlans.filter(
      (p) => p.enabled && p.roundsDone < p.roundsTotal && p.nextRunAt <= now,
    );
  },

  addDcaPlan(plan: DcaPlan): void {
    load().dcaPlans.push(plan);
    flush();
  },

  updateDcaPlan(id: string, patch: Partial<DcaPlan>): void {
    const p = load().dcaPlans.find((x) => x.id === id);
    if (!p) return;
    Object.assign(p, patch);
    flush();
  },

  removeDcaPlan(id: string): void {
    const d = load();
    d.dcaPlans = d.dcaPlans.filter((p) => p.id !== id);
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
    cache = { version: 1, wallets: [], settings: defaultSettings(), tradeLog: [], positions: {}, rules: [], copyTargets: [], dcaPlans: [] };
  },

  /**
   * Drop the in-memory copy so the next read comes off disk.
   *
   * Nothing in the running bot needs this — it holds the only handle on the
   * file. It exists so the load path itself can be exercised: the migration
   * logic in `load()` is where a bad decision silently destroys keys.
   */
  reload(): void {
    cache = null;
  },
};
