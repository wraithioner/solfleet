import type { Keypair } from '@solana/web3.js';
import {
  LAMPORTS,
  BASE_FEE_LAMPORTS,
  MAX_TRANSFERS_PER_TX,
  getSolBalances,
  sendSolBatch,
} from '../chains/solana.js';
import { solanaKeypair } from '../store/wallets.js';
import { chunk, errMessage } from '../util.js';
import { log } from '../logger.js';
import type { WalletRecord, ExecutionResult, BatchSummary } from '../types.js';
import type { ProgressFn } from './engine.js';

/**
 * Distribution — the opposite direction to a sweep.
 *
 * Batch buying is only useful if the wallets doing the buying hold SOL, and
 * getting SOL into fifty wallets by hand is exactly the drudgery this bot
 * exists to remove. Planning is kept separate from sending so the arithmetic —
 * which decides how much of the operator's money moves — can be tested offline.
 */

export type FundMode = 'each' | 'topup';

export interface FundTransfer {
  walletId: string;
  label: string;
  address: string;
  lamports: bigint;
}

export interface FundSkip {
  walletId: string;
  label: string;
  address: string;
  reason: string;
}

export interface FundPlan {
  mode: FundMode;
  transfers: FundTransfer[];
  skipped: FundSkip[];
  /** Total leaving the source wallet, excluding fees. */
  totalLamports: bigint;
  /** What the transactions carrying this plan will cost in fees. */
  feeLamports: bigint;
  /** Transactions the plan will be sent as. */
  txCount: number;
}

/**
 * A top-up deficit smaller than the fee to deliver it is not worth a transfer.
 */
const DUST_LAMPORTS = BigInt(BASE_FEE_LAMPORTS);

/**
 * Work out who gets what, and refuse up front if the source cannot cover it.
 *
 * `each` sends the same amount to every wallet. `topup` brings each wallet up
 * to the target, which is what you want after a round of trading has left every
 * wallet holding a different remainder.
 */
export function planFunding(opts: {
  targets: Array<Pick<WalletRecord, 'id' | 'label' | 'address'>>;
  /** Lamports held by each target, keyed by address. Missing = zero. */
  balances: Map<string, bigint>;
  mode: FundMode;
  /** Amount per wallet, in whole SOL. */
  sol: number;
  sourceLamports: bigint;
  priorityFeeSol: number;
  /** SOL the source keeps back, so it can still pay a fee afterwards. */
  reserveSol?: number;
}): FundPlan {
  const perWallet = BigInt(Math.floor(opts.sol * LAMPORTS));
  if (perWallet <= 0n) throw new Error('Amount must be greater than zero.');

  const transfers: FundTransfer[] = [];
  const skipped: FundSkip[] = [];

  for (const t of opts.targets) {
    const held = opts.balances.get(t.address) ?? 0n;
    const lamports = opts.mode === 'each' ? perWallet : perWallet - held;

    if (lamports <= DUST_LAMPORTS) {
      skipped.push({
        walletId: t.id,
        label: t.label,
        address: t.address,
        reason: opts.mode === 'topup' ? 'already funded' : 'amount below the transfer fee',
      });
      continue;
    }

    transfers.push({ walletId: t.id, label: t.label, address: t.address, lamports });
  }

  const totalLamports = transfers.reduce((sum, t) => sum + t.lamports, 0n);
  const txCount = Math.ceil(transfers.length / MAX_TRANSFERS_PER_TX);
  const perTxFee = BigInt(BASE_FEE_LAMPORTS) + BigInt(Math.floor(opts.priorityFeeSol * LAMPORTS));
  const feeLamports = BigInt(txCount) * perTxFee;

  // A main wallet drained to exactly zero cannot pay the fee on anything it does
  // next, so it keeps the same reserve a sweep leaves in every other wallet.
  const reserveLamports = BigInt(Math.floor((opts.reserveSol ?? 0) * LAMPORTS));

  // Refuse before signing anything rather than half-funding the set and leaving
  // the operator to work out which wallets missed out.
  if (totalLamports + feeLamports + reserveLamports > opts.sourceLamports) {
    const need = Number(totalLamports + feeLamports + reserveLamports) / LAMPORTS;
    const have = Number(opts.sourceLamports) / LAMPORTS;
    throw new Error(
      `Main wallet holds ${have.toFixed(4)} SOL but this needs ${need.toFixed(4)} SOL ` +
        `including fees${reserveLamports > 0n ? ` and a ${opts.reserveSol} SOL reserve` : ''}.`,
    );
  }

  return { mode: opts.mode, transfers, skipped, totalLamports, feeLamports, txCount };
}

/**
 * Execute a plan. Transactions go out one after another because they all spend
 * from the same wallet — firing them concurrently races the source balance and
 * turns a funding run into a scatter of "insufficient lamports" failures.
 */
export async function executeFunding(
  source: WalletRecord,
  plan: FundPlan,
  priorityFeeSol: number,
  onProgress?: ProgressFn,
): Promise<BatchSummary> {
  const startedAt = Date.now();
  const results: ExecutionResult[] = [];

  // wallets that needed nothing are reported as done, not as failures
  for (const s of plan.skipped) {
    results.push({
      walletId: s.walletId,
      label: s.label,
      address: s.address,
      ok: true,
      detail: s.reason,
    });
  }

  if (plan.transfers.length === 0) {
    await onProgress?.(0, 0);
    return summarise(results, startedAt);
  }

  let signer: Keypair;
  try {
    signer = solanaKeypair(source);
  } catch (err) {
    for (const t of plan.transfers) {
      results.push({ walletId: t.walletId, label: t.label, address: t.address, ok: false, error: errMessage(err) });
    }
    return summarise(results, startedAt);
  }

  const groups = chunk(plan.transfers, MAX_TRANSFERS_PER_TX);
  let done = 0;

  for (const [gi, group] of groups.entries()) {
    try {
      const signature = await sendSolBatch(
        signer,
        group.map((t) => ({ to: t.address, lamports: t.lamports })),
        priorityFeeSol,
      );

      for (const t of group) {
        results.push({
          walletId: t.walletId,
          label: t.label,
          address: t.address,
          ok: true,
          signature,
          detail: `${(Number(t.lamports) / LAMPORTS).toFixed(6)} SOL`,
        });
      }
    } catch (err) {
      log.warn(`Funding transaction ${gi + 1}/${groups.length} failed: ${errMessage(err)}`);
      for (const t of group) {
        results.push({
          walletId: t.walletId,
          label: t.label,
          address: t.address,
          ok: false,
          error: errMessage(err),
        });
      }
    } finally {
      done += group.length;
      await onProgress?.(done, plan.transfers.length, `transaction ${gi + 1}/${groups.length}`);
    }
  }

  return summarise(results, startedAt);
}

/** Read the balances a plan needs, batched. */
export async function fundingBalances(addresses: string[]): Promise<Map<string, bigint>> {
  if (addresses.length === 0) return new Map();
  return getSolBalances(addresses);
}

/**
 * Split wallets into those that can cover a spend and those that cannot.
 *
 * A wallet holding less SOL than the trade is about to spend cannot succeed, and
 * firing at it anyway turns an underfunded set into a wall of red rows.
 *
 * What counts as "enough" is `requiredForBuy`, which is deliberately not just
 * the trade size: it covers the token account rent the first buy has to pay and
 * the fee the eventual sell will need. Being slightly strict here costs a wallet
 * one trade; being loose costs a position that fills and then cannot be closed.
 */
export function partitionByBalance<T extends { address: string }>(
  wallets: T[],
  balances: Map<string, bigint>,
  requiredLamports: bigint,
): { funded: T[]; unfunded: T[] } {
  // a short read is not evidence of empty wallets; treat it as unknown and let
  // every wallet through rather than silently skipping a trade the operator asked for
  if (balances.size < wallets.length) return { funded: wallets, unfunded: [] };

  const funded: T[] = [];
  const unfunded: T[] = [];

  for (const w of wallets) {
    if ((balances.get(w.address) ?? 0n) >= requiredLamports) funded.push(w);
    else unfunded.push(w);
  }

  return { funded, unfunded };
}

/**
 * Rent locked up by the SPL token account a first buy has to open.
 *
 * 165 bytes at the rent-exempt minimum. It is refunded when the account is
 * closed, but while the position is held it is spent as far as the wallet is
 * concerned — and at roughly 400× the base signature fee, leaving it out of a
 * buy requirement is the difference between a fill and "insufficient lamports".
 */
export const ATA_RENT_LAMPORTS = 2_039_280n;

/**
 * What a wallet must keep back to be able to sell.
 *
 * A wallet that spends its last lamport getting into a position cannot sign its
 * way out of one: the sell needs a signature fee and a priority fee of its own,
 * and a token you cannot sell is worth nothing however far it runs. Two sells'
 * worth is reserved rather than one, so a failed attempt — a slippage revert, a
 * dropped blockhash — still leaves enough to try again.
 */
export function exitReserveLamports(priorityFeeSol: number, jitoTipSol = 0): bigint {
  const perAttempt =
    BigInt(BASE_FEE_LAMPORTS) +
    BigInt(Math.floor(priorityFeeSol * LAMPORTS)) +
    BigInt(Math.floor(jitoTipSol * LAMPORTS));
  return perAttempt * 2n;
}

/**
 * What one wallet must hold to complete a buy *and still be able to exit it*.
 *
 * The buy amount is only part of it: the transaction pays a signature and
 * priority fee, opening the token account costs rent, a bundled send carries a
 * tip, and the sell that eventually closes the position has to be affordable
 * from what is left.
 */
export function requiredForBuy(
  solPerWallet: number,
  priorityFeeSol: number,
  opts: { jitoTipSol?: number; needsTokenAccount?: boolean; wrapsSol?: boolean } = {},
): bigint {
  const tip = opts.jitoTipSol ?? 0;

  // the account the tokens land in
  let rent = opts.needsTokenAccount === false ? 0n : ATA_RENT_LAMPORTS;

  /*
   * Buying on an AMM costs a second rent-exempt account.
   *
   * A bonding-curve buy pays lamports straight to the curve. Every graduated
   * venue is an SPL-token pool, so the SOL has to be wrapped first: the
   * transaction opens a WSOL account, funds it, swaps, and closes it again. The
   * close refunds the rent, but the wallet has to be able to put it up in the
   * first place — and a wallet short by exactly this fails the whole buy.
   *
   * Confirmed by decoding what PumpPortal builds for a graduated token: create
   * and fund a WSOL account, create the token account, swap, close the WSOL
   * account.
   */
  if (opts.wrapsSol) rent += ATA_RENT_LAMPORTS;

  return (
    BigInt(Math.floor(solPerWallet * LAMPORTS)) +
    BigInt(BASE_FEE_LAMPORTS) +
    BigInt(Math.floor(priorityFeeSol * LAMPORTS)) +
    BigInt(Math.floor(tip * LAMPORTS)) +
    rent +
    exitReserveLamports(priorityFeeSol, tip)
  );
}

function summarise(results: ExecutionResult[], startedAt: number): BatchSummary {
  return {
    results,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    startedAt,
    finishedAt: Date.now(),
  };
}
