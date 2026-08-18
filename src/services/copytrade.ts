import { PublicKey } from '@solana/web3.js';
import { rpc, WSOL_MINT, getMintBalances, LAMPORTS } from '../chains/solana.js';
import { db, type CopyTarget, type CopyExitMode } from '../store/db.js';
import { selectWallets } from '../store/wallets.js';
import { batchPumpTrade } from '../trade/engine.js';
import { retry, errMessage, fmtAmount } from '../util.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import type { Notifier } from './watcher.js';

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

  const parsed = await retry(
    () => rpc().getParsedTransactions(fresh, { maxSupportedTransactionVersion: 0 }),
    { attempts: 2 },
  );

  for (const tx of parsed) {
    if (!tx?.meta) continue;
    const moves = detectTokenMoves(
      (tx.meta.preTokenBalances ?? []) as ParsedBalance[],
      (tx.meta.postTokenBalances ?? []) as ParsedBalance[],
      target.address,
    );

    // what the whole transaction cost them, used to size a proportional copy
    const theirSol = solSpent(
      tx.transaction.message.accountKeys as ParsedAccount[],
      tx.meta.preBalances ?? [],
      tx.meta.postBalances ?? [],
      target.address,
    );

    for (const move of moves) {
      if (move.delta > 0) await mirrorBuy(target, move, theirSol, notify);
      else if (target.exitMode !== 'off') await mirrorSell(target, move, notify);
    }
  }
}

/** How many copied buys this target has already made into one token. */
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

  // claim the entry before spending, so a crash mid-buy cannot replay it
  db.updateCopyTarget(target.id, {
    copiedMints: target.copiedMints.includes(move.mint)
      ? target.copiedMints
      : [...target.copiedMints, move.mint],
    entryCounts: { ...(target.entryCounts ?? {}), [move.mint]: already + 1 },
  });
  if (!target.copiedMints.includes(move.mint)) target.copiedMints.push(move.mint);
  target.entryCounts = { ...(target.entryCounts ?? {}), [move.mint]: already + 1 };

  const settings = db.settings();
  log.info(`Copying ${target.label} into ${move.mint} (entry ${already + 1}/${allowed})`);

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
    db.recordBuy(move.mint, perWallet * fills, fills);
    db.appendTradeLog({
      at: Date.now(),
      action: `copy buy ${fmtAmount(perWallet, 4)} SOL`,
      mint: move.mint,
      walletCount: wallets.length,
      succeeded: summary.succeeded,
      failed: summary.failed,
      note: `copied ${target.label} (entry ${already + 1}/${allowed})`,
    });

    await notify(`👥 Copy buy done — ✅ ${summary.succeeded}  ❌ ${summary.failed}`).catch(() => {});
  } catch (err) {
    await notify(`❌ Copy buy failed: <i>${errMessage(err)}</i>`).catch(() => {});
  }
}

async function mirrorSell(target: CopyTarget, move: TokenMove, notify: Notifier): Promise<void> {
  const wallets = selectWallets();
  if (wallets.length === 0) return;

  // only act if we actually hold it
  const held = await getMintBalances(wallets.map((w) => w.address), move.mint).catch(() => new Map());
  if (held.size === 0) return;

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
      `👥 <b>${target.label} sold ${percent}%</b>\n<code>${move.mint}</code>\n\nMirrored — ✅ ${summary.succeeded}  ❌ ${summary.failed}`,
    ).catch(() => {});
  } catch (err) {
    await notify(`❌ Copy sell failed: <i>${errMessage(err)}</i>`).catch(() => {});
  }
}
