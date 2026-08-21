import { PublicKey } from '@solana/web3.js';
import { rpc, WSOL_MINT, getMintBalances, LAMPORTS } from '../chains/solana.js';
import { db, type CopyTarget, type CopyExitMode } from '../store/db.js';
import { selectWallets } from '../store/wallets.js';
import { batchPumpTrade, measureTokensGained } from '../trade/engine.js';
import { retry, errMessage, fmtAmount } from '../util.js';
import { config } from '../config.js';
import { assessToken, type SafetyVerdict } from './safety.js';
import { getTokenInfo, type TokenInfo } from './tokeninfo.js';
import { log } from '../logger.js';
import { newRuleId, type Notifier } from './watcher.js';

/**
 * Copy trading: mirror another wallet's entries and exits.
 *
 * How it works, and its honest limitation. The bot polls the target's recent
 * signatures and reads each transaction's token balance changes — no indexer or
 * webhook required, so it works on a plain RPC. But polling means the copy
 * lands seconds behind the wallet being copied, and on a memecoin those seconds
 * are the move. This follows a trader's positions; it does not race them, and
 * nothing built on an interval timer could.
 */

export interface TokenMove {
  mint: string;
  /** Change in whole tokens: positive is a buy, negative a sell. */
  delta: number;
  /** What they held before, used to size a proportional exit. */
  before: number;
}

interface ParsedAccount {
  pubkey: { toBase58(): string } | string;
}

interface ParsedBalance {
  mint: string;
  owner?: string;
  uiTokenAmount: { uiAmount: number | null };
}

/**
 * What one wallet's token holdings did in a single transaction.
 *
 * Kept pure and separate from the RPC so the interpretation — which is what
 * decides whether real money is spent — can be tested without a network.
 */
export function detectTokenMoves(
  pre: ParsedBalance[],
  post: ParsedBalance[],
  owner: string,
): TokenMove[] {
  const before = new Map<string, number>();
  const after = new Map<string, number>();

  for (const b of pre) {
    if (b.owner !== owner) continue;
    before.set(b.mint, (before.get(b.mint) ?? 0) + (b.uiTokenAmount.uiAmount ?? 0));
  }
  for (const b of post) {
    if (b.owner !== owner) continue;
    after.set(b.mint, (after.get(b.mint) ?? 0) + (b.uiTokenAmount.uiAmount ?? 0));
  }

  const moves: TokenMove[] = [];
  for (const mint of new Set([...before.keys(), ...after.keys()])) {
    // wrapped SOL moves on nearly every swap and means nothing on its own
    if (mint === WSOL_MINT) continue;

    const start = before.get(mint) ?? 0;
    const end = after.get(mint) ?? 0;
    const delta = end - start;

    // ignore dust: rounding and rent-exempt remnants are not trades
    if (Math.abs(delta) < 1e-9) continue;
    moves.push({ mint, delta, before: start });
  }

  return moves;
}

/**
 * How much SOL an address parted with in one transaction.
 *
 * This is what makes proportional sizing possible: the token balance change
 * says *what* they bought, and only the native balance change says how much
 * conviction was behind it. Positive is spent, negative is received.
 *
 * The number includes the transaction fee and any rent for accounts opened
 * along the way when the address is the fee payer. On a memecoin buy those are
 * a rounding error next to the trade, and erring slightly high is the safe
 * direction for a cap to be wrong in.
 */
export function solSpent(
  accountKeys: ParsedAccount[],
  preBalances: number[],
  postBalances: number[],
  owner: string,
): number {
  const index = accountKeys.findIndex((a) => {
    const key = typeof a.pubkey === 'string' ? a.pubkey : a.pubkey.toBase58();
    return key === owner;
  });
  if (index < 0) return 0;

  const before = preBalances[index];
  const after = postBalances[index];
  if (before === undefined || after === undefined) return 0;

  return (before - after) / LAMPORTS;
}

/**
 * The least SOL a wallet must part with for an arriving token to count as a buy.
 *
 * A token balance going up does not mean they bought anything. Anyone can send
 * tokens to anyone, and dusting a wallet that other people copy is a way of
 * getting those people to buy something worthless — the recipient pays nothing,
 * is not even the fee payer, and their balance rises exactly as it would after
 * a purchase. Their SOL is the only thing that tells the two apart.
 *
 * Where the floor sits, and why not lower. Receiving a token is not free for
 * the recipient when they pay their own fees: opening the token account it
 * lands in costs 0.00204 SOL of rent, a wrapped-SOL account alongside it
 * another 0.00204, and a fat priority fee can add a further 0.002. So a pure
 * receipt can cost its holder the better part of half a hundredth of a SOL
 * while buying nothing — measured on chain, wallets gaining nine million
 * tokens for 0.004 SOL. A floor under that reads those as purchases.
 *
 * 0.01 SOL clears it with room, and is also the smallest quick-buy this bot
 * offers: if they spent less than the least you would ever choose to spend, it
 * is not a signal worth paying for.
 *
 * It also excludes a token-for-token swap, where they genuinely acquired
 * something without SOL leaving. Pricing the input side would be the fix;
 * declining to copy a trade is cheaper than copying a poisoned one.
 */
export const MIN_SPEND_FOR_BUY_SOL = 0.01;

/**
 * Did they pay for this, or did it simply arrive?
 *
 * Pure and exported because it decides whether money moves, and the cost of
 * getting it wrong is a real buy of a token somebody chose for you.
 */
export function isPurchase(theirSol: number): boolean {
  return Number.isFinite(theirSol) && theirSol >= MIN_SPEND_FOR_BUY_SOL;
}

/**
 * SOL to commit to one copied buy, across the whole batch.
 *
 * Percent mode is deliberately a share of the batch rather than a share per
 * wallet: "copy him at 5%" should mean a position 5% the size of his, not 5%
 * multiplied by however many wallets happen to be running.
 */
export function copyBuySol(
  target: Pick<CopyTarget, 'sizeMode' | 'buySol' | 'sizePercent'>,
  theirSol: number,
  walletCount: number,
  maxPerWallet: number,
): number {
  if (walletCount <= 0) return 0;

  const perWallet =
    target.sizeMode === 'percent'
      ? (theirSol * (target.sizePercent / 100)) / walletCount
      : target.buySol;

  if (!Number.isFinite(perWallet) || perWallet <= 0) return 0;

  // the per-wallet safety cap still applies however the number was arrived at
  return Math.min(perWallet, maxPerWallet);
}

/**
 * What share of our position to sell when they sell some of theirs.
 *
 * `proportional` copies the trim as a trim. `all` reads any sell as the exit
 * signal and closes the whole position — a trader who takes 10% off the top is
 * often on the way out, and being seconds behind them makes a partial follow
 * the worst of both. Returns 0 when nothing should be sold.
 */
export function copySellPercent(mode: CopyExitMode, move: TokenMove): number {
  if (mode === 'off') return 0;
  if (mode === 'all') return 100;

  // they may have sold from a balance we never saw grow; treat that as a full exit
  if (move.before <= 0) return 100;

  const share = (Math.abs(move.delta) / move.before) * 100;
  // never round a real sell down to nothing, and never past a full exit
  return Math.min(100, Math.max(1, Math.round(share)));
}

/**
 * Arm this target's own exits on a position it just opened.
 *
 * Only ever adds what is missing. A second entry into the same token must not
 * stack a second stop-loss on it, and a rule the operator changed by hand on
 * the token's own screen is theirs — this does not overwrite either.
 */
export function armCopyRules(target: CopyTarget, mint: string, notify?: Notifier): void {
  const existing = db.rulesFor(mint);
  const armed: string[] = [];
  const skipped: string[] = [];

  const add = (kind: 'take_profit' | 'stop_loss', triggerPct: number, sellPercent: number) => {
    if (existing.some((r) => r.kind === kind && !r.firedAt)) {
      skipped.push(kind === 'take_profit' ? `TP +${triggerPct}%` : `SL ${triggerPct}%`);
      return;
    }
    db.addRule({
      id: newRuleId(),
      mint,
      kind,
      triggerPct,
      sellPercent,
      enabled: true,
      createdAt: Date.now(),
    });
    armed.push(kind === 'take_profit' ? `TP +${triggerPct}%` : `SL ${triggerPct}%`);
  };

  if (target.takeProfitPct !== undefined) {
    add('take_profit', target.takeProfitPct, target.takeProfitSellPct ?? 50);
  }
  if (target.stopLossPct !== undefined) {
    add('stop_loss', -Math.abs(target.stopLossPct), 100);
  }

  if (armed.length > 0) {
    log.info(`Armed ${armed.join(' and ')} on ${mint} from ${target.label}.`);
    void notify?.(`🤖 Armed <b>${armed.join('</b> and <b>')}</b> on this position.`).catch(() => {});
  }

  /*
   * A rule already on the mint wins, and the operator is told which of this
   * target's settings were therefore not used.
   *
   * One position takes one set of exits — stacking a second stop-loss on the
   * same coin would sell it twice. But when two followed wallets are configured
   * differently the surviving set is a mixture of the two, and it used to
   * assemble itself in silence. Someone who set a trader to −30% has a right to
   * know their position is running on somebody else's −50%.
   */
  if (skipped.length > 0) {
    log.info(
      `${target.label}'s ${skipped.join(' and ')} not armed on ${mint}: ` +
        'the position already carries a rule of that kind.',
    );
    void notify?.(
      `ℹ️ <b>${target.label}</b>'s ${skipped.join(' and ')} was not added — ` +
        'this position already has one of each. The existing rules stand.',
    ).catch(() => {});
  }
}

/**
 * Judge a token against the copy-trade limits, failing closed.
 *
 * A lookup that throws leaves every field undefined, and `assessToken` reads
 * unknown as unsafe — so a rate-limited RPC refuses the buy rather than waving
 * it through. That is the right way round: a missed entry costs nothing that
 * can be measured, and the alternative is an unattended buy into a token
 * nothing could be read about.
 */
async function screenToken(mint: string): Promise<{ verdict: SafetyVerdict; info?: TokenInfo }> {
  const limits = db.settings().copySafety;
  try {
    const info = await getTokenInfo(mint, 'solana');
    return { verdict: assessToken(info, limits), info };
  } catch (err) {
    return {
      verdict: {
        safe: false,
        reasons: [`Could not read the token to check it: ${errMessage(err)}`],
        notes: [],
      },
    };
  }
}

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
 * every path claims a signature here before it spends anything. Bounded,
 * because the only ones worth remembering are the recent ones — anything older
 * is behind `lastSignature` and will not be offered again.
 */
const processed = new Set<string>();
const PROCESSED_MAX = 600;

/** Test seam: forget what has been seen, as a fresh process would. */
export function resetProcessed(): void {
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
async function handleSignature(target: CopyTarget, signature: string, notify: Notifier): Promise<void> {
  if (!claimSignature(signature)) return;

  const [tx] = await retry(
    () => rpc().getParsedTransactions([signature], { maxSupportedTransactionVersion: 0 }),
    { attempts: 2 },
  );
  if (!tx?.meta || tx.meta.err) return;

  const moves = detectTokenMoves(
    (tx.meta.preTokenBalances ?? []) as ParsedBalance[],
    (tx.meta.postTokenBalances ?? []) as ParsedBalance[],
    target.address,
  );
  if (moves.length === 0) return;

  // what the whole transaction cost them, used to size a proportional copy
  const theirSol = solSpent(
    tx.transaction.message.accountKeys as ParsedAccount[],
    tx.meta.preBalances ?? [],
    tx.meta.postBalances ?? [],
    target.address,
  );

  // re-read: the stored target may have been edited since this was queued
  const current = db.copyTargets().find((t) => t.id === target.id);
  if (!current || !current.enabled) return;

  for (const move of moves) {
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
        continue;
      }
      await mirrorBuy(current, move, theirSol, notify);
    } else if (current.exitMode !== 'off') {
      await mirrorSell(current, move, notify);
    }
  }
}

async function pollTarget(target: CopyTarget, notify: Notifier): Promise<void> {
  const signatures = await retry(
    () => rpc().getSignaturesForAddress(new PublicKey(target.address), { limit: 10 }),
    { attempts: 2 },
  );
  if (signatures.length === 0) return;

  const newest = signatures[0]!.signature;

  /*
   * First sight of a wallet records where it is and stops. Without this, adding
   * a target would immediately mirror its last ten transactions — buying a
   * fistful of positions the operator never chose, some of them hours stale.
   */
  if (!target.lastSignature) {
    db.updateCopyTarget(target.id, { lastSignature: newest });
    // everything already on screen is history, not a signal to act on
    for (const s of signatures) claimSignature(s.signature);
    return;
  }

  // oldest first, so their sequence is followed in the order it happened
  const fresh: string[] = [];
  for (const s of signatures) {
    if (s.signature === target.lastSignature) break;
    if (!s.err) fresh.push(s.signature);
  }
  if (fresh.length === 0) return;
  fresh.reverse();

  db.updateCopyTarget(target.id, { lastSignature: newest });

  for (const signature of fresh) await handleSignature(target, signature, notify);
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

function enqueue(item: Queued): void {
  if (queue.length >= QUEUE_MAX) {
    const dropped = (floodCounts.get(item.target.address) ?? 0) + 1;
    floodCounts.set(item.target.address, dropped);

    if (dropped === FLOOD_LIMIT) {
      log.warn(`${item.target.label} is too busy to follow — dropping its subscription.`);
      void unsubscribe(item.target.address);
      void item
        .notify(
          `⚠️ <b>Stopped following ${item.target.label}</b>\n\n` +
            '<i>That address transacts far faster than a person trades — it looks like a program or an ' +
            'exchange wallet, not a trader. Following it would read nothing useful and rate-limit ' +
            'everything else. Unfollow it and pick a wallet that trades.</i>',
        )
        .catch(() => {});
    }
    return;
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
      await handleSignature(item.target, item.signature, item.notify).catch((err) =>
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
  await rpc().removeOnLogsListener(id).catch(() => {});
}

export async function syncSubscriptions(notify: Notifier): Promise<void> {
  const targets = db.activeCopyTargets();
  const wanted = new Map(targets.map((t) => [t.address, t]));

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
        (logs) => {
          if (logs.err) return; // a failed transaction moved nothing
          enqueue({ target, signature: logs.signature, notify });
        },
        'confirmed',
      );
      subscriptions.set(address, id);
      log.info(`Watching ${target.label} live over the websocket.`);
    } catch (err) {
      log.warn(`Could not subscribe to ${target.label}, falling back to polling: ${errMessage(err)}`);
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
  const mine = new Promise<void>((resolve) => (release = resolve));

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
 * SOL already committed to a mint, from every source.
 *
 * Measured cost where it exists, which includes the fees and rent a copy pays.
 * Hand-bought size counts too: the cap is a statement about how much of one
 * coin the operator is willing to hold, and money spent by tapping a button is
 * no less spent than money spent automatically.
 */
export function exposureSol(mint: string): number {
  const pos = db.position(mint);
  if (!pos) return 0;
  return pos.costSol ?? pos.investedSol;
}

/** Room left under the per-mint cap. Infinity when the cap is off. */
export function roomUnderCap(mint: string, maxSolPerMint: number): number {
  if (maxSolPerMint <= 0) return Infinity;
  return Math.max(0, maxSolPerMint - exposureSol(mint));
}

function entriesSoFar(target: CopyTarget, mint: string): number {
  const counted = target.entryCounts?.[mint];
  if (counted !== undefined) return counted;
  // records written before entryCounts existed only ever made one entry
  return target.copiedMints.includes(mint) ? 1 : 0;
}

async function mirrorBuy(
  target: CopyTarget,
  move: TokenMove,
  theirSol: number,
  notify: Notifier,
): Promise<void> {
  // every decision below reads state that a concurrent copy would change
  return withMintLock(move.mint, () => mirrorBuyLocked(target, move, theirSol, notify));
}

async function mirrorBuyLocked(
  target: CopyTarget,
  move: TokenMove,
  theirSol: number,
  notify: Notifier,
): Promise<void> {
  // a token this target was already refused is not reconsidered: the answer
  // will not have changed, and re-reading it turns one bad coin into a stream
  if (target.refusedMints?.includes(move.mint)) return;

  const already = entriesSoFar(target, move.mint);

  /*
   * How far to follow a trader averaging in. On `first` their opening buy is
   * the signal and the rest is noise; on `every` we average in with them, up to
   * a cap — without one, how much of the operator's money goes into a token
   * would be decided entirely by how many times somebody else clicks buy.
   */
  const allowed = target.entryMode === 'every' ? Math.max(1, target.maxEntries) : 1;
  if (already >= allowed) {
    if (already === allowed && target.entryMode === 'every') {
      log.info(`Copy cap reached for ${move.mint} from ${target.label} (${allowed} entries).`);
    }
    return;
  }

  const wallets = selectWallets();
  if (wallets.length === 0) return;

  const perWallet = copyBuySol(target, theirSol, wallets.length, config.safety.maxBuySolPerWallet);
  if (perWallet <= 0) {
    log.warn(`Skipped copying ${target.label} into ${move.mint}: computed size was zero.`);
    return;
  }

  /*
   * How much of this one coin the operator ends up holding.
   *
   * The entry cap above is stored on the followed wallet, so it bounds how
   * often THIS trader can pull you into a token and nothing else. Follow three
   * wallets that all buy the same coin and you take three full-size entries,
   * because none of the three records can see the other two. This is the only
   * check that sees the position rather than the follower.
   *
   * The batch is refused whole rather than trimmed to fit. A size the operator
   * did not choose is worse than a skip they can read: the message says what is
   * already in, what this would have added, and where the limit is.
   */
  const limits = db.settings().copySafety;
  const room = roomUnderCap(move.mint, limits.maxSolPerMint);
  const batchSol = perWallet * wallets.length;

  if (batchSol > room) {
    log.warn(
      `Skipped copying ${target.label} into ${move.mint}: ` +
        `${exposureSol(move.mint).toFixed(4)} SOL already in, this adds ${batchSol.toFixed(4)}, ` +
        `cap is ${limits.maxSolPerMint} SOL.`,
    );
    await notify(
      [
        `🧯 <b>Did not copy ${target.label}</b>`,
        `<code>${move.mint}</code>`,
        '',
        `Already holding <b>${exposureSol(move.mint).toFixed(4)} ◎</b> of this coin.`,
        `This copy would add <b>${batchSol.toFixed(4)} ◎</b>, over the <b>${limits.maxSolPerMint} ◎</b> per-token cap.`,
        '',
        '<i>Copy trading → Safety → Per token to change it.</i>',
      ].join('\n'),
    ).catch(() => {});
    return;
  }

  /*
   * Claim the slot BEFORE the screening call, not after.
   *
   * `screenToken` is a network round trip, and two of this target's own
   * transactions arriving close together — one down the socket, one from the
   * reconciling poll, which calls in outside the socket's serial queue — could
   * both read the same entry count while the other was suspended inside it, and
   * both go on to spend. The mint lock closes that window for good, and writing
   * the claim first means even a lock that failed cannot produce a double buy.
   */
  db.updateCopyTarget(target.id, {
    entryCounts: { ...(target.entryCounts ?? {}), [move.mint]: already + 1 },
  });
  target.entryCounts = { ...(target.entryCounts ?? {}), [move.mint]: already + 1 };

  /*
   * Read the token before buying it.
   *
   * The trader being followed may be the deployer, may be exit liquidity, or
   * may simply be wrong. Nothing about their buy says the token can be sold
   * again, and this is the only buy in the bot that nobody looks at first.
   *
   * The entry is claimed either way. A token refused once should not be
   * reconsidered on their next buy into it — the answer will not have changed,
   * and re-reading it every time turns one bad token into a stream of alerts.
   */
  const { verdict, info } = await screenToken(move.mint);
  if (!verdict.safe) {
    /*
     * Recorded as refused, not as copied. Those were once the same list, which
     * meant a coin the gate had rejected — nothing bought, no money spent —
     * still counted as a position this target was entitled to sell out of.
     */
    db.updateCopyTarget(target.id, {
      refusedMints: (target.refusedMints ?? []).includes(move.mint)
        ? target.refusedMints
        : [...(target.refusedMints ?? []), move.mint],
      entryCounts: { ...(target.entryCounts ?? {}), [move.mint]: allowed },
    });

    log.warn(`Refused to copy ${target.label} into ${move.mint}: ${verdict.reasons.join(' ')}`);
    await notify(
      [
        `🛡 <b>Did not copy ${target.label}</b>`,
        `<code>${move.mint}</code>`,
        '',
        ...verdict.reasons.map((r) => `· ${r}`),
        '',
        '<i>Copy trading → Safety to change these limits.</i>',
      ].join('\n'),
    ).catch(() => {});
    return;
  }

  /*
   * Now it counts as copied. The slot was claimed before the screening call;
   * this list means something narrower and is written only here — the wallets
   * are about to hold this coin because of this trader, which is the fact the
   * exit path needs and the only one that should let their sell move it.
   */
  db.updateCopyTarget(target.id, {
    copiedMints: target.copiedMints.includes(move.mint)
      ? target.copiedMints
      : [...target.copiedMints, move.mint],
  });
  if (!target.copiedMints.includes(move.mint)) target.copiedMints.push(move.mint);

  const settings = db.settings();
  log.info(`Copying ${target.label} into ${move.mint} (entry ${already + 1}/${allowed})`);

  // read before the trade so the fill can be measured against it
  const addresses = wallets.map((w) => w.address);
  const heldBefore = await getMintBalances(addresses, move.mint).catch(() => undefined);

  const sizing =
    target.sizeMode === 'percent'
      ? `${target.sizePercent}% of their ${fmtAmount(theirSol, 3)} SOL`
      : `${target.buySol} SOL each`;

  await notify(
    [
      `👥 <b>${target.label} bought</b>`,
      `<code>${move.mint}</code>`,
      '',
      `Entry ${already + 1}/${allowed} · ${sizing}`,
      `Mirroring ${fmtAmount(perWallet, 4)} SOL × ${wallets.length} wallets…`,
    ].join('\n'),
  ).catch(() => {});

  try {
    const summary = await batchPumpTrade(wallets, {
      action: 'buy',
      mint: move.mint,
      amount: perWallet,
      denominatedInSol: true,
      slippagePercent: settings.slippagePercent,
      priorityFeeSol: settings.priorityFeeSol,
      pool: 'auto',
    });

    const fills = summary.results.filter((r) => r.ok && r.signature).length;

    // the token count is the cost basis: without it there is no entry price,
    // and without an entry price a take-profit or stop-loss cannot fire at all
    const tokensGained = await measureTokensGained(addresses, move.mint, heldBefore, info?.decimals);
    db.recordBuy(move.mint, perWallet * fills, fills, tokensGained, info?.symbol, summary.solSpent);

    if (fills > 0) armCopyRules(target, move.mint, notify);
    db.appendTradeLog({
      at: Date.now(),
      action: `copy buy ${fmtAmount(perWallet, 4)} SOL`,
      mint: move.mint,
      walletCount: wallets.length,
      succeeded: summary.succeeded,
      failed: summary.failed,
      note: `copied ${target.label} (entry ${already + 1}/${allowed})`,
    });

    await notify(`👥 Copy buy done — ✅ ${summary.succeeded}  ❌ ${summary.failed}${firstReason(summary)}`).catch(
      () => {},
    );
  } catch (err) {
    await notify(`❌ Copy buy failed: <i>${errMessage(err)}</i>`).catch(() => {});
  }
}

/**
 * The reason behind a failure count.
 *
 * A watcher-fired batch has no screen to open, so a bare "❌ 1" is the whole
 * report — and it says nothing about whether the wallet was short, the token
 * untradeable, or the network down. The first distinct reason is worth more
 * than the count on its own.
 */
function firstReason(summary: { results: Array<{ ok: boolean; error?: string }> }): string {
  const reasons = [...new Set(summary.results.filter((r) => !r.ok && r.error).map((r) => r.error!))];
  if (reasons.length === 0) return '';
  const more = reasons.length > 1 ? ` <i>(+${reasons.length - 1} other reason${reasons.length > 2 ? 's' : ''})</i>` : '';
  return `\n\n<i>${reasons[0]!.slice(0, 250)}</i>${more}`;
}

async function mirrorSell(target: CopyTarget, move: TokenMove, notify: Notifier): Promise<void> {
  /*
   * Only exit what this trader actually put you into.
   *
   * Holding the coin used to be the entire test, which made every followed
   * wallet a trigger for every position in the book. A trader selling a token
   * they had nothing to do with — one bought by hand, or copied from somebody
   * else entirely — closed it anyway, and in `all` mode closed all of it. The
   * trader whose exit this mirrors has to be the trader whose entry opened it.
   *
   * Two conditions, because neither is sufficient alone. `copiedMints` says
   * this target opened it; a recorded cost basis says a buy actually landed,
   * which covers records written before refusals were kept in their own list
   * and so cannot distinguish a rejected coin from a bought one.
   */
  if (!target.copiedMints.includes(move.mint)) {
    log.info(`Ignored ${target.label} selling ${move.mint}: never copied from them.`);
    return;
  }
  if (exposureSol(move.mint) <= 0) {
    log.info(`Ignored ${target.label} selling ${move.mint}: no recorded position to exit.`);
    return;
  }

  const wallets = selectWallets();
  if (wallets.length === 0) return;

  // only act if we actually hold it
  const held = await getMintBalances(wallets.map((w) => w.address), move.mint).catch(() => new Map());
  if (held.size === 0) {
    // the wallets that built this position may sit outside the active group,
    // in which case the exit silently does nothing — say so rather than not
    log.warn(`Copied exit for ${move.mint} found nothing to sell in the selected wallets.`);
    return;
  }

  const percent = copySellPercent(target.exitMode, move);
  if (percent <= 0) return;

  const settings = db.settings();
  log.info(`Copying ${target.label} out of ${move.mint} (${percent}%)`);

  try {
    const summary = await batchPumpTrade(wallets, {
      action: 'sell',
      mint: move.mint,
      amount: percent,
      denominatedInSol: false,
      slippagePercent: settings.slippagePercent,
      priorityFeeSol: settings.priorityFeeSol,
      pool: 'auto',
    });

    db.appendTradeLog({
      at: Date.now(),
      action: `copy sell ${percent}%`,
      mint: move.mint,
      walletCount: wallets.length,
      succeeded: summary.succeeded,
      failed: summary.failed,
      note: `copied ${target.label}`,
    });

    await notify(
      `👥 <b>${target.label} sold ${percent}%</b>\n<code>${move.mint}</code>\n\n` +
        `Mirrored — ✅ ${summary.succeeded}  ❌ ${summary.failed}${firstReason(summary)}`,
    ).catch(() => {});
  } catch (err) {
    await notify(`❌ Copy sell failed: <i>${errMessage(err)}</i>`).catch(() => {});
  }
}
