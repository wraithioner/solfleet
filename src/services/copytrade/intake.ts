import { PublicKey, type ParsedTransactionWithMeta } from '@solana/web3.js';
import { rpc } from '../../chains/solana.js';
import { db, type CopyTarget } from '../../store/db.js';
import { retry, errMessage, escapeHtml as h } from '../../util.js';
import { log } from '../../logger.js';
import type { Notifier } from '../watcher.js';
import { executionEpoch, assertExecutionEpoch } from '../execution.js';
import { detectTokenMoves, solSpent, isPurchase } from './events.js';
import { currentTarget, noted } from './state.js';
import { mirrorBuy } from './buy.js';
import { mirrorSell } from './sell.js';
import { reviewFeedHealth, queueEvictionIndex } from './intake-policy.js';

/** Poll every enabled target once. Called from the watcher tick. */
export async function pollCopyTargets(notify: Notifier): Promise<void> {
  for (const target of db.activeCopyTargets()) {
    try {
      await pollTarget(target, notify);
    } catch (err) {
      log.warn(`Copy target ${target.label} failed: ${errMessage(err)}`);
    }
  }
}

/*
 * Signatures already acted on.
 *
 * The same transaction can arrive twice: once pushed down the socket and again
 * when the reconciling poll sweeps up. Copying it twice would buy twice, so
 * Durable receipts on each target govern execution. This bounded in-memory
 * set supports diagnostics; it is never the only record of a copied event.
 */
const processed = new Set<string>();
const PROCESSED_MAX = 600;
const receiptReads = new Map<string, Promise<boolean>>();
const targetReads = new Map<string, Promise<void>>();

function receiptKey(target: CopyTarget, signature: string): string {
  return JSON.stringify([target.id, signature]);
}

/** Persist before money can move; a crash must never replay an uncertain copy. */
function rememberReceipt(target: CopyTarget, signature: string): void {
  if (target.handledSignatures?.includes(signature)) return;
  db.updateCopyTarget(target.id, {
    handledSignatures: [...(target.handledSignatures ?? []), signature].slice(-PROCESSED_MAX),
  });
  claimSignature(receiptKey(target, signature));
}

/** Test seam: forget what has been seen, as a fresh process would. */
export function resetProcessed(): void {
  claims.socket = 0;
  claims.poll = 0;
  warnedSocketQuiet = false;
  processed.clear();
}

/** How many of their transactions have been read this run. */
export function processedCount(): number {
  return processed.size;
}

export function claimSignature(signature: string): boolean {
  if (processed.has(signature)) return false;
  processed.add(signature);
  if (processed.size > PROCESSED_MAX) {
    // Sets iterate in insertion order, so this drops the oldest
    for (const old of processed) {
      processed.delete(old);
      if (processed.size <= PROCESSED_MAX) break;
    }
  }
  return true;
}

/** Read one of their transactions and mirror whatever it did. */
/**
 * Which path got to a transaction first, counted.
 *
 * The socket is the mechanism and the poll is the safety net, so in a healthy
 * system almost every transaction is claimed by the socket and the poll finds
 * nothing left to do. If that inverts, the socket has stopped delivering — and
 * nothing about that is visible from the outside, because the poll quietly
 * covers for it. What the operator sees is copies landing twenty seconds late
 * for no stated reason, which is exactly the complaint that is impossible to
 * diagnose without this count.
 */
const claims = { socket: 0, poll: 0 };
let warnedSocketQuiet = false;

export function claimStats(): { socket: number; poll: number } {
  return { ...claims };
}

/**
 * Say so when the safety net is doing the work.
 *
 * Once, and only on a real sample. A socket that recovers resets the count, so
 * a single bad spell does not leave a permanent warning standing.
 */
async function checkSocketHealth(notify: Notifier): Promise<void> {
  const total = claims.socket + claims.poll;
  const review = reviewFeedHealth(claims, warnedSocketQuiet);
  warnedSocketQuiet = review.warned;
  if (review.rebuild) {
    /*
     * Rebuild the subscriptions rather than only reporting them.
     *
     * The difference this covers is not two and a half seconds against three —
     * it is against twenty. A socket delivering normally puts a copied trade in
     * front of us about 1.7 seconds after the block, and the poll that stands
     * in for a dead one runs on a twenty-second tick.
     *
     * The client reconnects its transport by itself, but a subscription that
     * was silently dropped on the way back leaves this end holding a handle to
     * nothing: we believe we are watching, the poll quietly covers, and the
     * only visible symptom is copies landing late for no stated reason. Tearing
     * the handles down is what makes `syncSubscriptions` create them again on
     * the same pass, a few lines below this.
     */
    const watching = [...subscriptions.keys()];
    log.warn(
      `The live socket is missing most transactions (${claims.poll}/${total} found by the poll instead). ` +
        `Rebuilding ${watching.length} subscription(s).`,
    );
    for (const address of watching) await unsubscribe(address);

    // the count starts over, or the rebuilt socket is judged on the dead one's
    // record and torn down again on the very next tick
    Object.assign(claims, review.claims);

    await notify(
      [
        '🐌 <b>Copy trading had slowed down</b>',
        '',
        `The live feed was missing most trades — ${total} checked, and the ` +
          'backup check on its 20-second tick was finding them first.',
        '',
        '<i>The connection has been rebuilt. Copies should be back to a couple of seconds.</i>',
      ].join('\n'),
    ).catch(() => {});
    return;
  }

  Object.assign(claims, review.claims);
}

async function handleSignature(
  target: CopyTarget,
  signature: string,
  notify: Notifier,
  source: 'socket' | 'poll' = 'socket',
): Promise<boolean> {
  const key = receiptKey(target, signature);
  const pending = receiptReads.get(key);
  if (pending) return pending;
  const epoch = executionEpoch();
  const previous = targetReads.get(target.id) ?? Promise.resolve();
  const work = previous
    .catch(() => {})
    .then(() => readSignature(target, signature, notify, source, epoch));
  const tail = work.then(
    () => {},
    () => {},
  );
  targetReads.set(target.id, tail);
  receiptReads.set(key, work);
  try {
    return await work;
  } finally {
    if (receiptReads.get(key) === work) receiptReads.delete(key);
    if (targetReads.get(target.id) === tail) targetReads.delete(target.id);
  }
}

async function readSignature(
  target: CopyTarget,
  signature: string,
  notify: Notifier,
  source: 'socket' | 'poll',
  epoch: number,
): Promise<boolean> {
  assertExecutionEpoch(epoch);
  const initial = currentTarget(target);
  if (!initial) return false;
  if (initial.handledSignatures?.includes(signature)) return true;

  let tx: ParsedTransactionWithMeta;
  try {
    tx = await retry(
      async () => {
        const [parsed] = await rpc().getParsedTransactions([signature], {
          maxSupportedTransactionVersion: 0,
        });
        // A confirmed log can precede this RPC's readable receipt. Null is a
        // retryable read, never evidence that the transaction was handled.
        if (!parsed?.meta) throw new Error('Copy transaction receipt is not yet readable.');
        return parsed;
      },
      { attempts: 2 },
    );
  } catch (err) {
    log.warn(
      `Could not read ${target.label}'s transaction; reconciliation will retry: ${errMessage(err)}`,
    );
    return false;
  }
  assertExecutionEpoch(epoch);
  const current = currentTarget(target);
  if (!current) return false;
  // Persist only after the receipt is readable, but before any submission.
  // This deliberately guarantees at most one attempt after a process crash.
  rememberReceipt(current, signature);
  claims[source]++;
  if (tx.meta!.err) return true;

  const moves = detectTokenMoves(
    tx.meta!.preTokenBalances ?? [],
    tx.meta!.postTokenBalances ?? [],
    current.address,
  );
  if (moves.length === 0) return true;

  // what the whole transaction cost them, used to size a proportional copy
  const theirSol = solSpent(
    tx.transaction.message.accountKeys,
    tx.meta!.preBalances ?? [],
    tx.meta!.postBalances ?? [],
    current.address,
  );

  for (const move of moves) {
    assertExecutionEpoch(epoch);
    if (!currentTarget(current)) return true;
    if (move.delta > 0) {
      /*
       * A token arriving is not a purchase. Someone dusting a followed wallet
       * would otherwise have this bot buy whatever they sent — and in fixed
       * sizing it would buy the configured amount, because that mode never
       * looks at what the trader spent.
       */
      if (!isPurchase(theirSol)) {
        log.info(
          `Ignored ${move.mint} from ${current.label}: they received it without spending SOL.`,
        );
        noted(current, move.mint, 'It was sent to them — they spent no SOL on it');
        continue;
      }
      await mirrorBuy(current, move, theirSol, notify);
    } else if (current.exitMode !== 'off') {
      await mirrorSell(current, move, notify);
    }
  }
  return true;
}

const POLL_PAGE_SIZE = 100;
const POLL_MAX_PAGES = 5;

async function pollTarget(target: CopyTarget, notify: Notifier): Promise<void> {
  const epoch = executionEpoch();
  const signatures = await retry(
    () => rpc().getSignaturesForAddress(new PublicKey(target.address), { limit: POLL_PAGE_SIZE }),
    { attempts: 2 },
  );
  assertExecutionEpoch(epoch);
  if (!currentTarget(target)) return;
  if (signatures.length === 0) return;

  const newest = signatures[0]!.signature;

  /*
   * First sight of a wallet records where it is and stops. Without this, adding
   * a target would immediately mirror its last ten transactions — buying a
   * fistful of positions the operator never chose, some of them hours stale.
   */
  if (!target.lastSignature) {
    db.updateCopyTarget(target.id, {
      lastSignature: newest,
      handledSignatures: [
        ...new Set([...(target.handledSignatures ?? []), ...signatures.map(s => s.signature)]),
      ].slice(-PROCESSED_MAX),
    });
    // everything already on screen is history, not a signal to act on
    for (const s of signatures) claimSignature(receiptKey(target, s.signature));
    return;
  }

  const cursor = target.lastSignature;
  const fresh: typeof signatures = [];
  let page = signatures;
  let foundCursor = false;
  for (let pages = 1; pages <= POLL_MAX_PAGES; pages++) {
    for (const s of page) {
      if (s.signature === cursor) {
        foundCursor = true;
        break;
      }
      fresh.push(s);
    }
    if (foundCursor || page.length < POLL_PAGE_SIZE || pages === POLL_MAX_PAGES) break;
    const before = page.at(-1)!.signature;
    page = await retry(
      () =>
        rpc().getSignaturesForAddress(new PublicKey(target.address), {
          limit: POLL_PAGE_SIZE,
          before,
        }),
      { attempts: 2 },
    );
    assertExecutionEpoch(epoch);
    if (!currentTarget(target)) return;
  }

  if (!foundCursor) {
    // A bounded history with an unknown gap cannot safely replay entries or
    // proportional exits. Preserve the cursor and require a deliberate resume.
    db.updateCopyTarget(target.id, { enabled: false });
    dropQueued(target.address);
    await unsubscribe(target.address);
    log.warn(
      `Paused ${target.label}: its previous signature was not found within ${fresh.length} receipts.`,
    );
    await notify(
      `⚠️ <b>Copy trading paused for ${h(target.label)}</b>\n\n` +
        `The previous checkpoint was missing from the last ${fresh.length} transactions. ` +
        'There may be a gap in the history, so no trades from this backlog were copied. ' +
        'Review this trader before following again.',
    ).catch(() => {});
    return;
  }

  // Advance only across resolved receipts, including transactions that failed
  // on chain. An unreadable receipt blocks this cursor until a later sweep.
  for (const s of fresh.reverse()) {
    assertExecutionEpoch(epoch);
    if (!currentTarget(target)) return;
    const signature = s.signature;
    if (s.err) rememberReceipt(target, signature);
    else if (!(await handleSignature(target, signature, notify, 'poll'))) return;
    assertExecutionEpoch(epoch);
    if (!currentTarget(target)) return;
    db.updateCopyTarget(target.id, { lastSignature: signature });
  }
}

// ── live subscriptions ────────────────────────────────────────────────────────

/**
 * Watch followed wallets over the RPC websocket instead of waiting for a poll.
 *
 * Polling every twenty seconds meant a copied entry landed, on average, ten
 * seconds after theirs and at worst twenty — an eternity on a token that moves
 * in one. The socket pushes each transaction as it confirms, measured at about
 * three seconds behind the chain against a Helius endpoint, and it costs no
 * requests at all: the poll was spending roughly 389,000 calls a month per
 * followed wallet to learn nothing most of the time.
 *
 * The poll stays as reconciliation rather than as the mechanism. A socket can
 * drop, and a dropped socket that nobody notices is a copy trader that silently
 * stopped copying — so the sweep still runs, finds almost everything already
 * claimed, and catches whatever fell through a reconnect.
 */
let subscriptions = new Map<string, number>();

/*
 * A queue between the socket and the RPC, because the socket does not care how
 * fast you can read.
 *
 * Every pushed signature costs a getParsedTransactions call. Subscribing to a
 * genuinely busy address — a program, an exchange wallet, anything that is not
 * one person trading — pushes hundreds a second, and firing a request at each
 * one buries the endpoint in 429s within a second. Measured: subscribing to the
 * pump.fun program produced an unbroken wall of rate-limit errors and read
 * nothing at all.
 *
 * One at a time, with a bounded backlog. A wallet that can overflow this is not
 * a trader whose entries can be copied, so it is dropped rather than throttled,
 * and the operator is told which one and why.
 */
interface Queued {
  target: CopyTarget;
  signature: string;
  notify: Notifier;
}

const queue: Queued[] = [];
const QUEUE_MAX = 25;
const FLOOD_LIMIT = 60;
const floodCounts = new Map<string, number>();
let draining = false;

function dropQueued(address: string): void {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i]!.target.address === address) queue.splice(i, 1);
  }
}

/**
 * Make room by dropping the stalest trade from the busiest wallet.
 *
 * Two things were wrong with refusing the new arrival instead. A copied trade
 * is worth following because it just happened — an entry from thirty seconds
 * ago is already priced in, so of everything in the queue the newest item is
 * the one to keep and the oldest is the one to lose.
 *
 * And the queue is shared. One address transacting like a program filled it
 * and every other followed wallet's trades were refused at the door, which is
 * the opposite of what a flood control should do: the wallet causing the
 * problem should be the one that loses its place.
 */
function evictOldest(): boolean {
  const index = queueEvictionIndex(queue.map(q => q.target.address));
  if (index < 0) return false;
  queue.splice(index, 1);
  return true;
}

function enqueue(item: Queued): void {
  if (queue.length >= QUEUE_MAX) {
    const dropped = (floodCounts.get(item.target.address) ?? 0) + 1;
    floodCounts.set(item.target.address, dropped);

    if (dropped === FLOOD_LIMIT) {
      log.warn(`${item.target.label} is too busy to follow — disabling the target.`);
      db.updateCopyTarget(item.target.id, { enabled: false });
      dropQueued(item.target.address);
      floodCounts.delete(item.target.address);
      void unsubscribe(item.target.address);
      void item
        .notify(
          `⚠️ <b>Stopped following ${h(item.target.label)}</b>\n\n` +
            '<i>That address transacts far faster than a person trades — it looks like a program or an ' +
            'exchange wallet, not a trader. Following it would read nothing useful and rate-limit ' +
            'everything else. Unfollow it and pick a wallet that trades.</i>',
        )
        .catch(() => {});
      return;
    }

    // the newest trade is the one worth having, so make room rather than
    // turning it away — and take that room from whoever is filling the queue
    if (!evictOldest()) return;
  }

  queue.push(item);
  void drain();
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const item = queue.shift()!;
      await handleSignature(item.target, item.signature, item.notify, 'socket').catch(err =>
        log.warn(`Live copy of ${item.target.label} failed: ${errMessage(err)}`),
      );
    }
  } finally {
    draining = false;
  }
}

async function unsubscribe(address: string): Promise<void> {
  const id = subscriptions.get(address);
  if (id === undefined) return;
  subscriptions.delete(address);
  await rpc()
    .removeOnLogsListener(id)
    .catch(() => {});
}

export async function syncSubscriptions(notify: Notifier): Promise<void> {
  await checkSocketHealth(notify);

  const targets = db.activeCopyTargets();
  const wanted = new Map(targets.map(t => [t.address, t]));

  for (const [address] of subscriptions) {
    if (wanted.has(address)) continue;
    await unsubscribe(address);
    log.info(`Stopped watching ${address.slice(0, 8)}…`);
  }

  for (const [address, target] of wanted) {
    if (subscriptions.has(address)) continue;
    try {
      const id = await rpc().onLogs(
        new PublicKey(address),
        logs => {
          if (logs.err) return; // a failed transaction moved nothing
          enqueue({ target, signature: logs.signature, notify });
        },
        'confirmed',
      );
      subscriptions.set(address, id);
      log.info(`Watching ${target.label} live over the websocket.`);
    } catch (err) {
      log.warn(
        `Could not subscribe to ${target.label}, falling back to polling: ${errMessage(err)}`,
      );
    }
  }
}

/** Drop every subscription. Called on shutdown. */
export async function stopSubscriptions(): Promise<void> {
  for (const address of [...subscriptions.keys()]) await unsubscribe(address);
  subscriptions = new Map();
  queue.length = 0;
  floodCounts.clear();
}

/** How many wallets are being watched live, for the screen that says so. */
export function liveSubscriptionCount(): number {
  return subscriptions.size;
}
