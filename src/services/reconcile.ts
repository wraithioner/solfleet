import { PublicKey } from '@solana/web3.js';
import { rpc } from '../chains/solana.js';
import { db } from '../store/db.js';
import { allWallets } from '../store/wallets.js';
import { detectTokenMoves, solSpent } from './copytrade.js';
import { errMessage, pMap } from '../util.js';
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

/** How far back to look. A thousand signatures is several weeks of a busy wallet. */
const SIGNATURE_LIMIT = 1000;
const PAGE = 200;

export interface Reconciliation {
  scanned: number;
  /** Mints whose recorded proceeds were short, and by how much. */
  repaired: Array<{ mint: string; symbol?: string; was: number; now: number }>;
  /** Wallets that could not be read; their sales are still missing. */
  failures: string[];
}

/**
 * Every sale of every mint these wallets made, in SOL that actually arrived.
 *
 * A sale is a transaction where the wallet's balance of some token went down.
 * The SOL side is read from the same transaction, so a sale routed through a
 * pool nobody indexes is measured exactly as well as one that was not.
 */
async function proceedsByMint(address: string): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  const owner = new PublicKey(address);

  let before: string | undefined;
  let seen = 0;

  while (seen < SIGNATURE_LIMIT) {
    const page = await rpc().getSignaturesForAddress(owner, { limit: PAGE, before });
    if (page.length === 0) break;

    const usable = page.filter((s) => !s.err).map((s) => s.signature);
    // parsed transactions come back in batches; the RPC caps these itself
    for (let i = 0; i < usable.length; i += 20) {
      const txs = await rpc().getParsedTransactions(usable.slice(i, i + 20), {
        maxSupportedTransactionVersion: 0,
      });

      for (const tx of txs) {
        if (!tx?.meta || tx.meta.err) continue;

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
         * between them by size. Rare, and guessing evenly would put a large
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
    before = page.at(-1)?.signature;
    if (page.length < PAGE) break;
  }

  return found;
}

/**
 * Top up any position whose recorded proceeds fall short of the chain.
 *
 * Only ever raises a figure. The scan reaches back a bounded distance, so an
 * older sale can fall outside it — reading that as "this position returned
 * less than we thought" would replace one wrong number with another.
 */
export async function rebuildRealised(): Promise<Reconciliation> {
  const wallets = allWallets();
  const failures: string[] = [];
  const chain = new Map<string, number>();

  await pMap(wallets, 2, async (w) => {
    try {
      for (const [mint, sol] of await proceedsByMint(w.address)) {
        chain.set(mint, (chain.get(mint) ?? 0) + sol);
      }
    } catch (err) {
      failures.push(`${w.label}: ${errMessage(err)}`);
      log.warn(`Reconcile failed for ${w.label}: ${errMessage(err)}`);
    }
  });

  const repaired: Reconciliation['repaired'] = [];
  for (const pos of db.positions()) {
    const onChain = chain.get(pos.mint);
    if (onChain === undefined) continue;
    // a tenth of a milli-SOL of drift is rounding, not a missing sale
    if (onChain <= pos.realisedSol + 0.0001) continue;

    repaired.push({ mint: pos.mint, symbol: pos.symbol, was: pos.realisedSol, now: onChain });
    db.setRealised(pos.mint, onChain);
  }

  log.info(
    `Reconciled ${repaired.length} position(s) against ${wallets.length} wallet(s); ` +
      `${failures.length} could not be read.`,
  );
  return { scanned: wallets.length, repaired, failures };
}
