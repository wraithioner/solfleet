import { PublicKey } from '@solana/web3.js';
import { rpc } from '../chains/solana.js';
import { db } from '../store/db.js';
import { allWallets } from '../store/wallets.js';
import { detectTokenMoves, solSpent } from './copytrade.js';
import { errMessage, retry, sleep } from '../util.js';
import { log } from '../logger.js';

/**
 * Rebuild what past sales returned, by reading the chain instead of the ledger.
 *
 * Four code paths sold tokens and only one recorded the proceeds, so positions
 * closed by a take-profit, a stop loss, a copied exit or sell-everything kept
 * their whole cost and none of their return. The money did arrive; nothing
 * wrote it down. The transactions are still on chain, which makes this
 * recoverable rather than merely explainable.
 *
 * Repair, not estimate. Every figure here is a SOL balance delta from a
 * confirmed transaction that reduced a token balance — the same measurement the
 * live path now takes, applied after the fact.
 */

/**
 * Paced to sit under a free-tier allowance rather than to finish quickly.
 *
 * The first version of this walked two wallets at once as fast as the socket
 * would carry it and was refused by the provider on both, which is worse than
 * slow: a scan that reads nothing cannot tell "no sales were missing" from "no
 * sales were read", and it reported the first. One wallet at a time, spaced,
 * and every call retried through a rate limit.
 */
const RPC_GAP_MS = 130;
const SIGNATURE_LIMIT = 1200;
const SIGNATURE_PAGE = 100;
const PARSE_BATCH = 10;

/** Everything before the first position was opened is not worth reading. */
const HISTORY_MARGIN_MS = 6 * 3_600_000;

export interface Reconciliation {
  walletsRead: number;
  walletsTotal: number;
  transactionsScanned: number;
  /** Mints whose recorded proceeds were short, and by how much. */
  repaired: Array<{ mint: string; symbol?: string; was: number; now: number }>;
  /** Wallets that could not be read; their sales are still missing. */
  failures: string[];
  /** True only when every wallet was read to the end. */
  complete: boolean;
}

export type ProgressFn = (note: string) => void | Promise<void>;

/** A rate limit is worth waiting through; anything else is worth reporting. */
function isRateLimited(err: unknown): boolean {
  return /429|too many requests|rate.?limit/i.test(errMessage(err));
}

async function paced<T>(fn: () => Promise<T>): Promise<T> {
  const out = await retry(fn, { attempts: 4, baseDelayMs: 900 });
  await sleep(RPC_GAP_MS);
  return out;
}

/**
 * Every sale of every mint one wallet made, in SOL that actually arrived.
 *
 * A sale is a transaction where the wallet's balance of some token went down.
 * The SOL side is read from the same transaction, so a sale routed through a
 * pool nobody indexes is measured exactly as well as one that was not.
 *
 * Throws only when nothing could be read at all. A page that fails after others
 * have succeeded returns what was found and says the scan is incomplete, since
 * partial proceeds still beat none — they can only raise the recorded figure.
 */
async function proceedsByMint(
  address: string,
  notBefore: number,
  onProgress?: ProgressFn,
): Promise<{ found: Map<string, number>; scanned: number; complete: boolean }> {
  const found = new Map<string, number>();
  const owner = new PublicKey(address);

  let before: string | undefined;
  let seen = 0;
  let scanned = 0;
  let pages = 0;

  while (seen < SIGNATURE_LIMIT) {
    let page;
    try {
      page = await paced(() =>
        rpc().getSignaturesForAddress(owner, { limit: SIGNATURE_PAGE, before }),
      );
    } catch (err) {
      // nothing read at all is a failure; a short read is a partial answer
      if (pages === 0) throw err;
      log.warn(`Reconcile stopped early for ${address.slice(0, 6)}…: ${errMessage(err)}`);
      return { found, scanned, complete: false };
    }
    pages++;
    if (page.length === 0) break;

    const usable = page.filter((s) => !s.err).map((s) => s.signature);

    for (let i = 0; i < usable.length; i += PARSE_BATCH) {
      let txs;
      try {
        txs = await paced(() =>
          rpc().getParsedTransactions(usable.slice(i, i + PARSE_BATCH), {
            maxSupportedTransactionVersion: 0,
          }),
        );
      } catch (err) {
        if (isRateLimited(err)) {
          log.warn(`Reconcile throttled for ${address.slice(0, 6)}…, stopping with what was read.`);
          return { found, scanned, complete: false };
        }
        throw err;
      }

      for (const tx of txs) {
        if (!tx?.meta || tx.meta.err) continue;
        scanned++;

        const moves = detectTokenMoves(
          (tx.meta.preTokenBalances ?? []) as never[],
          (tx.meta.postTokenBalances ?? []) as never[],
          address,
        );
        const sold = moves.filter((m) => m.delta < 0);
        if (sold.length === 0) continue;

        /*
         * `solSpent` is signed from the wallet's point of view, so a sale is a
         * negative spend. Fees are already inside it, which is what makes this
         * the amount that arrived rather than the amount the pool quoted.
         */
        const received = -solSpent(
          tx.transaction.message.accountKeys as never[],
          tx.meta.preBalances ?? [],
          tx.meta.postBalances ?? [],
          address,
        );
        if (received <= 0) continue;

        /*
         * A transaction that closed two positions at once splits its proceeds
         * between them by size. Rare, and splitting evenly would put a large
         * coin's return against a dust one.
         */
        const total = sold.reduce((sum, m) => sum + Math.abs(m.delta), 0);
        for (const m of sold) {
          const share = total > 0 ? Math.abs(m.delta) / total : 1 / sold.length;
          found.set(m.mint, (found.get(m.mint) ?? 0) + received * share);
        }
      }
    }

    seen += page.length;
    await onProgress?.(`${address.slice(0, 4)}… ${seen} transactions`);

    // history older than the first position cannot contain one of its sales
    const oldest = page.at(-1)?.blockTime;
    if (oldest !== undefined && oldest !== null && oldest * 1000 < notBefore) {
      return { found, scanned, complete: true };
    }

    before = page.at(-1)?.signature;
    if (page.length < SIGNATURE_PAGE) break;
  }

  return { found, scanned, complete: true };
}

/**
 * Top up any position whose recorded proceeds fall short of the chain.
 *
 * Only ever raises a figure. The scan reaches back a bounded distance, so an
 * older sale can fall outside it — reading that as "this position returned
 * less than we thought" would replace one wrong number with another.
 */
export async function rebuildRealised(onProgress?: ProgressFn): Promise<Reconciliation> {
  const wallets = allWallets();
  const positions = db.positions();

  // no need to read further back than the first position was opened
  const earliest = positions.reduce(
    (min, p) => Math.min(min, p.firstBuyAt || Date.now()),
    Date.now(),
  );
  const notBefore = earliest - HISTORY_MARGIN_MS;

  const failures: string[] = [];
  const chain = new Map<string, number>();
  let walletsRead = 0;
  let transactionsScanned = 0;
  let complete = true;

  // one at a time: the provider counts calls per second, not per wallet
  for (const w of wallets) {
    try {
      await onProgress?.(`reading ${w.label}`);
      const result = await proceedsByMint(w.address, notBefore, onProgress);
      for (const [mint, sol] of result.found) chain.set(mint, (chain.get(mint) ?? 0) + sol);
      transactionsScanned += result.scanned;
      if (!result.complete) complete = false;
      walletsRead++;
    } catch (err) {
      complete = false;
      failures.push(`${w.label}: ${errMessage(err).slice(0, 80)}`);
      log.warn(`Reconcile failed for ${w.label}: ${errMessage(err)}`);
    }
  }

  const repaired: Reconciliation['repaired'] = [];
  for (const pos of positions) {
    const onChain = chain.get(pos.mint);
    if (onChain === undefined) continue;
    // a tenth of a milli-SOL of drift is rounding, not a missing sale
    if (onChain <= pos.realisedSol + 0.0001) continue;

    repaired.push({ mint: pos.mint, symbol: pos.symbol, was: pos.realisedSol, now: onChain });
    db.setRealised(pos.mint, onChain);
  }

  log.info(
    `Reconciled ${repaired.length} position(s) from ${transactionsScanned} transactions across ` +
      `${walletsRead}/${wallets.length} wallet(s)${complete ? '' : ' — incomplete'}.`,
  );

  return {
    walletsRead,
    walletsTotal: wallets.length,
    transactionsScanned,
    repaired,
    failures,
    complete,
  };
}
