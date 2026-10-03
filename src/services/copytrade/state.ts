import { db, type CopyTarget } from '../../store/db.js';
import { assertExecutionCurrent } from '../execution.js';

export function currentTarget(target: CopyTarget): CopyTarget | undefined {
  const current = db.copyTargets().find(t => t.id === target.id);
  return current?.enabled ? current : undefined;
}

export function assertCopyCurrent(target: CopyTarget): void {
  assertExecutionCurrent();
  if (!currentTarget(target))
    throw new Error('Copy target was disabled or removed before execution.');
}

export function copyIntent(target: CopyTarget): string {
  return JSON.stringify({
    address: target.address,
    buySol: target.buySol,
    sizeMode: target.sizeMode,
    sizePercent: target.sizePercent,
    entryMode: target.entryMode,
    maxEntries: target.maxEntries,
    exitMode: target.exitMode,
    takeProfitPct: target.takeProfitPct,
    stopLossPct: target.stopLossPct,
    takeProfitSellPct: target.takeProfitSellPct,
  });
}
/** How many copied buys this target has already made into one token. */
/*
 * One copied buy per mint at a time, across every followed wallet.
 *
 * Two followed wallets buying the same coin are two different transactions, so
 * nothing upstream collapses them — and both used to read the exposure so far,
 * both see room under the cap, and both spend. The same is true of one wallet
 * arriving twice: `pollTarget` calls straight into `handleSignature` outside
 * the socket's serial queue, and the gap between reading the entry count and
 * claiming it spans a network round trip.
 *
 * Serialising per mint rather than skipping keeps the outcome deterministic. A
 * second trader's buy is not dropped because it happened to land during the
 * first; it waits, re-reads what has been spent, and is judged against a cap
 * that now includes the buy in front of it.
 */
const mintLocks = new Map<string, Promise<void>>();

export async function withMintLock<T>(mint: string, fn: () => Promise<T>): Promise<T> {
  const previous = mintLocks.get(mint) ?? Promise.resolve();

  let release!: () => void;
  const mine = new Promise<void>(resolve => (release = resolve));

  // the queue's new tail, kept by identity: the map holds this exact promise
  // until somebody chains behind it, and comparing against `mine` instead
  // never matches, so the entry is never removed and the map grows for the
  // lifetime of the process — one leaked entry per coin ever copied
  const tail = previous.then(() => mine);
  mintLocks.set(mint, tail);

  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    // nobody queued behind me, so the coin is idle and the entry can go
    if (mintLocks.get(mint) === tail) mintLocks.delete(mint);
  }
}

/** Test seam: how many mints are mid-copy. */
export function activeMintLocks(): number {
  return mintLocks.size;
}
/**
 * Write down a decision not to copy, so it can be answered for later.
 *
 * These were all log lines, which is to say invisible: from Telegram the
 * symptom is a followed wallet buying something and nothing happening, which
 * looks exactly like the bot being asleep.
 *
 * This is also where refusals live rather than in Telegram. A skip is not news
 * — it is a coin you do not own, declined for a reason that has not changed
 * since the last time it was declined — and a stream of them buries the
 * messages that do mean something. They are read on 📋 Why it skipped, when
 * somebody wants to know why a trade did not happen. What still goes to
 * Telegram is anything that needs an answer.
 */
export function noted(target: CopyTarget, mint: string, reason: string, symbol?: string): void {
  db.recordCopyDecision({ at: Date.now(), target: target.label, mint, symbol, reason });
}
