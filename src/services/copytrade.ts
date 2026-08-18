import { PublicKey } from '@solana/web3.js';
import { rpc, WSOL_MINT, getMintBalances } from '../chains/solana.js';
import { db, type CopyTarget } from '../store/db.js';
import { selectWallets } from '../store/wallets.js';
import { batchPumpTrade } from '../trade/engine.js';
import { retry, errMessage } from '../util.js';
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

    for (const move of moves) {
      if (move.delta > 0) await mirrorBuy(target, move, notify);
      else if (target.copySells) await mirrorSell(target, move, notify);
    }
  }
}

async function mirrorBuy(target: CopyTarget, move: TokenMove, notify: Notifier): Promise<void> {
  // one copy per token per target — a trader scaling in over twenty
  // transactions must not drag the operator into twenty separate buys
  if (target.copiedMints.includes(move.mint)) return;

  db.updateCopyTarget(target.id, { copiedMints: [...target.copiedMints, move.mint] });
  target.copiedMints.push(move.mint);

  const wallets = selectWallets();
  if (wallets.length === 0) return;

  const settings = db.settings();
  log.info(`Copying ${target.label} into ${move.mint}`);

  await notify(
    [
      `👥 <b>${target.label} bought</b>`,
      `<code>${move.mint}</code>`,
      '',
      `Mirroring ${target.buySol} SOL × ${wallets.length} wallets…`,
    ].join('\n'),
  ).catch(() => {});

  try {
    const summary = await batchPumpTrade(wallets, {
      action: 'buy',
      mint: move.mint,
      amount: target.buySol,
      denominatedInSol: true,
      slippagePercent: settings.slippagePercent,
      priorityFeeSol: settings.priorityFeeSol,
      pool: 'auto',
    });

    const fills = summary.results.filter((r) => r.ok && r.signature).length;
    db.recordBuy(move.mint, target.buySol * fills, fills);
    db.appendTradeLog({
      at: Date.now(),
      action: `copy buy ${target.buySol} SOL`,
      mint: move.mint,
      walletCount: wallets.length,
      succeeded: summary.succeeded,
      failed: summary.failed,
      note: `copied ${target.label}`,
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

  // sell the same share of our position that they sold of theirs, so a partial
  // trim is copied as a trim rather than as a full exit
  const soldShare = move.before > 0 ? Math.min(100, (Math.abs(move.delta) / move.before) * 100) : 100;
  const percent = Math.max(1, Math.round(soldShare));

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
