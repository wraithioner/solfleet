import { createHash } from 'node:crypto';
import { PublicKey, type ParsedTransactionWithMeta } from '@solana/web3.js';
import bs58 from 'bs58';
import { rpc } from '../chains/solana.js';
import { db } from '../store/db.js';
import { allWallets } from '../store/wallets.js';
import { errMessage, retry, sleep } from '../util.js';
import { log } from '../logger.js';
import { assertExecutionEpoch, executionEpoch, withExecution } from './execution.js';

/**
 * Rebuild what past sales returned, by reading the chain instead of the ledger.
 *
 * Four code paths sold tokens and only one recorded the proceeds, so positions
 * closed by a take-profit, a stop loss, a copied exit or sell-everything kept
 * their whole cost and none of their return. The money did arrive; nothing
 * wrote it down. The transactions are still on chain, which makes this
 * recoverable rather than merely explainable.
 *
 * Repair, not estimate. Only supported, isolated swaps with an attributable
 * token debit and SOL return can raise the ledger. An asset transfer alongside
 * wallet funding is not evidence of a sale; uncertain transactions leave the
 * scan incomplete instead of manufacturing proceeds.
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
  /** True only when every wallet was read and candidate sales were attributable. */
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

/** Injectable reads and pacing allow history scans to be checked offline. */
export interface ReconcileServices {
  rpc: () => Pick<ReturnType<typeof rpc>, 'getSignaturesForAddress' | 'getParsedTransactions'>;
  paced: typeof paced;
}

const reconcileServices: ReconcileServices = { rpc, paced };

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);
const WSOL = 'So11111111111111111111111111111111111111112';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

// Bounded support from the programs' published IDLs. A program ID alone does
// not distinguish a swap from liquidity removal or closing an account.
// https://github.com/jup-ag/jupiter-cpi/blob/main/idl.json
// https://github.com/pump-fun/pump-public-docs/tree/main/idl
const swapInstructions = new Map<string, Set<string>>([
  ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', new Set([
    'route', 'route_with_token_ledger', 'shared_accounts_route',
    'shared_accounts_route_with_token_ledger', 'exact_out_route', 'shared_accounts_exact_out_route',
  ])],
  [PUMP, new Set(['sell'])],
  ['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', new Set(['sell'])],
]);
const swapPrefixes = new Map([...swapInstructions].map(([program, names]) => [program,
  new Set([...names].map((name) => createHash('sha256').update(`global:${name}`).digest('hex').slice(0, 16))),
]));
type Instruction = ParsedTransactionWithMeta['transaction']['message']['instructions'][number];
const keyString = (key: string | PublicKey) => typeof key === 'string' ? key : key.toBase58();
const instructionProgram = (ix: Instruction) => keyString(ix.programId);
const parsedInfo = (ix: Instruction): { type: string; info: Record<string, unknown> } | undefined =>
  'parsed' in ix && ix.parsed && typeof ix.parsed.type === 'string' && ix.parsed.info
    ? ix.parsed : undefined;
const isSwap = (ix: Instruction): boolean => {
  if (!('data' in ix)) return false;
  try {
    const prefix = Buffer.from(bs58.decode(ix.data)).subarray(0, 8).toString('hex');
    return swapPrefixes.get(instructionProgram(ix))?.has(prefix) ?? false;
  } catch { return false; }
};
const rawAmount = (value: unknown): bigint | undefined => {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) return undefined;
  const amount = BigInt(value);
  return amount <= 18_446_744_073_709_551_615n ? amount : undefined;
};
const validLamports = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * This intentionally declines unfamiliar programs, composed swaps, and missing
 * instruction/balance evidence. Raw quantities only compare the same mint.
 * The return is wallet SOL net of fees/outlays, less pre-existing balances
 * refunded by closed accounts; rent and old WSOL cannot become sale proceeds.
 */
function saleProceeds(tx: ParsedTransactionWithMeta, owner: string):
  { mint: string; sol: number } | 'none' | 'ambiguous' {
  const meta = tx.meta!;
  if (!meta.preTokenBalances || !meta.postTokenBalances) return 'ambiguous';
  const keys = tx.transaction.message.accountKeys.map((a) => keyString(a.pubkey));
  const ownerIndex = keys.indexOf(owner);
  if (ownerIndex < 0 || !validLamports(meta.preBalances[ownerIndex]) ||
      !validLamports(meta.postBalances[ownerIndex])) return 'ambiguous';
  const received = (meta.postBalances[ownerIndex]! - meta.preBalances[ownerIndex]!) / 1e9;
  const accounts = new Map<string, { mint: string; owner: string }>();
  const totals = new Map<string, { before: bigint; after: bigint; decimals: number }>();
  for (const [balances, side] of [
    [meta.preTokenBalances, 'before'], [meta.postTokenBalances, 'after'],
  ] as const) {
    for (const b of balances) {
      // Historical RPC responses may omit owners. Their effect is unknowable.
      if (!b.owner) return 'ambiguous';
      const account = keys[b.accountIndex];
      if (!account) return 'ambiguous';
      const old = accounts.get(account);
      if (old && (old.mint !== b.mint || old.owner !== b.owner)) return 'ambiguous';
      accounts.set(account, { mint: b.mint, owner: b.owner });
      if (b.owner !== owner) continue;
      const amount = rawAmount(b.uiTokenAmount.amount);
      const decimals = b.uiTokenAmount.decimals;
      if (amount === undefined || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
        return 'ambiguous';
      }
      const total = totals.get(b.mint) ?? { before: 0n, after: 0n, decimals };
      if (total.decimals !== decimals) return 'ambiguous';
      total[side] += amount;
      totals.set(b.mint, total);
    }
  }
  const sold = [...totals].filter(([mint, t]) => mint !== WSOL && t.after < t.before);
  if (sold.length === 0) return 'none';
  const instructions = tx.transaction.message.instructions;
  if (!Array.isArray(instructions)) return 'ambiguous';
  const swaps = instructions.flatMap((ix, i) => isSwap(ix) ? [i] : []);
  if (received <= 0) {
    // A recognized transfer/burn can be fully read without being a SOL sale.
    // Unknown programs may have sold for unredeemed WSOL or another quote mint.
    const plainTransfer = instructions.length > 0 && instructions.every((ix) => {
      const program = instructionProgram(ix);
      if (program === 'ComputeBudget111111111111111111111111111111') return true;
      const parsed = parsedInfo(ix);
      if (!parsed) return false;
      if (TOKEN_PROGRAMS.has(program)) return /^(transfer(Checked)?(WithFee)?|burn(Checked)?|closeAccount)$/.test(parsed.type);
      return program === SYSTEM_PROGRAM && /^transfer/.test(parsed.type) && parsed.info.source === owner;
    });
    return plainTransfer ? 'none' : 'ambiguous';
  }
  // Different token units have no meaningful ratio for allocating one SOL delta.
  if (sold.length !== 1 || swaps.length !== 1 ||
      [...totals].some(([mint, t]) => mint !== WSOL && t.after > t.before)) return 'ambiguous';
  const [mint, total] = sold[0]!;
  const swapIndex = swaps[0]!;
  const swap = instructions[swapIndex]!;
  if (!('accounts' in swap) || !swap.accounts.some((a) => keyString(a) === owner) ||
      !tx.transaction.message.accountKeys[ownerIndex]?.signer) return 'ambiguous';
  if (!Array.isArray(meta.innerInstructions)) return 'ambiguous';
  const all = instructions.map((ix, root) => ({ ix, root }));
  for (const group of meta.innerInstructions) {
    if (!Number.isInteger(group.index) || !instructions[group.index]) return 'ambiguous';
    all.push(...group.instructions.map((ix) => ({ ix, root: group.index })));
  }
  // Temporary WSOL accounts can be created and closed in one transaction,
  // absent from both token balance snapshots. Use their initialization evidence.
  for (const { ix } of all) {
    const parsed = parsedInfo(ix);
    if (!parsed) continue;
    const { type, info } = parsed;
    if ((TOKEN_PROGRAMS.has(instructionProgram(ix)) && /^initializeAccount[23]?$/.test(type)) ||
        (instructionProgram(ix) === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' && /^create/.test(type))) {
      const tokenOwner = info.owner ?? info.wallet;
      if (typeof info.account === 'string' && typeof info.mint === 'string' && typeof tokenOwner === 'string') {
        const previous = accounts.get(info.account);
        if (previous && (previous.mint !== info.mint || previous.owner !== tokenOwner)) return 'ambiguous';
        accounts.set(info.account, { mint: info.mint, owner: tokenOwner });
      }
    }
  }
  const closes = new Set<string>();
  let refunds = 0;
  for (const { ix } of all) {
    if (!TOKEN_PROGRAMS.has(instructionProgram(ix))) continue;
    const parsed = parsedInfo(ix);
    if (parsed?.type !== 'closeAccount' || parsed.info.destination !== owner) continue;
    const account = parsed.info.account;
    if (typeof account !== 'string' || closes.has(account)) return 'ambiguous';
    const index = keys.indexOf(account);
    if (index < 0 || !validLamports(meta.preBalances[index]) || meta.postBalances[index] !== 0) return 'ambiguous';
    closes.add(account);
    refunds += meta.preBalances[index]! / 1e9;
  }

  let debit = 0n;
  let wrappedReturn = 0n;
  const safeOuter = new Set([
    SYSTEM_PROGRAM, ...TOKEN_PROGRAMS,
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    'ComputeBudget111111111111111111111111111111',
  ]);
  for (const { ix, root } of all) {
    const program = instructionProgram(ix);
    if (root !== swapIndex && !safeOuter.has(program)) return 'ambiguous';
    const parsed = parsedInfo(ix);
    if (program === SYSTEM_PROGRAM) {
      if (!parsed) return 'ambiguous';
      const { info } = parsed;
      const destination = info.destination ?? info.newAccount;
      const source = info.source ?? info.fromPubkey;
      const target = typeof destination === 'string' ? accounts.get(destination) : undefined;
      if (root !== swapIndex && source !== owner &&
          (destination === owner || target?.owner === owner || closes.has(String(destination)))) return 'ambiguous';
    }
    if (!TOKEN_PROGRAMS.has(program)) continue;
    if (!parsed) return 'ambiguous';
    if (!/^transfer(Checked)?(WithFee)?$/.test(parsed.type)) {
      if (root !== swapIndex && !/^(initializeAccount[23]?|initializeImmutableOwner|getAccountDataSize|syncNative|closeAccount)$/.test(parsed.type)) {
        return 'ambiguous';
      }
      continue;
    }
    const { info } = parsed;
    const source = typeof info.source === 'string' ? accounts.get(info.source) : undefined;
    const destination = typeof info.destination === 'string' ? accounts.get(info.destination) : undefined;
    const amount = rawAmount(info.amount ?? (info.tokenAmount as { amount?: unknown } | undefined)?.amount);
    if (source?.owner === owner && source.mint === mint) {
      if (root !== swapIndex || destination?.owner === owner || amount === undefined ||
          !('accounts' in swap) || !swap.accounts.some((a) => keyString(a) === info.source)) return 'ambiguous';
      debit += amount;
    }
    if (destination?.owner === owner && destination.mint === mint) return 'ambiguous';
    if (destination?.owner === owner && destination.mint === WSOL) {
      if (root !== swapIndex || amount === undefined || !closes.has(String(info.destination))) return 'ambiguous';
      wrappedReturn += amount;
    }
  }
  if (debit !== total.before - total.after) return 'ambiguous';
  const sol = received - refunds;
  if (!Number.isFinite(sol) || sol <= 0) return 'ambiguous';
  // Pump's legacy bonding curve sell pays native lamports directly. Other
  // supported routes must show WSOL paid to an account redeemed to this wallet.
  if (instructionProgram(swap) !== PUMP &&
      (wrappedReturn === 0n || sol > Number(wrappedReturn) / 1e9 + 1e-9)) return 'ambiguous';
  return { mint, sol };
}

/**
 * Every sale of every mint one wallet made, in SOL that actually arrived.
 *
 * A sale needs a supported swap instruction, its token debit, and SOL return.
 * Unknown programs or combined sales leave the accounting incomplete.
 *
 * Read failures remain errors. A signature page that fails after earlier pages
 * returns their measured proceeds and says the scan is incomplete. Unreadable
 * transactions or uncertain sale attribution also make the scan incomplete.
 */
export async function proceedsByMint(
  address: string,
  notBefore: number,
  onProgress?: ProgressFn,
  services: ReconcileServices = reconcileServices,
): Promise<{ found: Map<string, number>; scanned: number; complete: boolean }> {
  if (!Number.isFinite(notBefore)) throw new Error('Invalid reconciliation history boundary');
  const found = new Map<string, number>();
  const owner = new PublicKey(address);
  const signaturesSeen = new Set<string>();

  let before: string | undefined;
  let seen = 0;
  let scanned = 0;
  let pages = 0;
  let incomplete = false;

  while (seen < SIGNATURE_LIMIT) {
    let page;
    try {
      page = await services.paced(() =>
        services.rpc().getSignaturesForAddress(owner, { limit: SIGNATURE_PAGE, before }),
      );
    } catch (err) {
      // nothing read at all is a failure; a short read is a partial answer
      if (pages === 0) throw err;
      log.warn(`Reconcile stopped early for ${address.slice(0, 6)}…: ${errMessage(err)}`);
      return { found, scanned, complete: false };
    }
    pages++;
    if (page.length === 0) return { found, scanned, complete: !incomplete };

    const usable = page.filter((s) => {
      if (signaturesSeen.has(s.signature)) { incomplete = true; return false; }
      signaturesSeen.add(s.signature);
      return !s.err && !(typeof s.blockTime === 'number' && s.blockTime * 1000 < notBefore);
    });

    for (let i = 0; i < usable.length; i += PARSE_BATCH) {
      let txs;
      try {
        txs = await services.paced(() =>
          services.rpc().getParsedTransactions(usable.slice(i, i + PARSE_BATCH).map((s) => s.signature), {
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

      if (txs.length !== usable.slice(i, i + PARSE_BATCH).length) incomplete = true;

      const batch = usable.slice(i, i + PARSE_BATCH);
      for (const [index, tx] of txs.slice(0, batch.length).entries()) {
        if (!tx?.meta) {
          incomplete = true;
          continue;
        }
        if (tx.meta.err) continue;
        const blockTime = tx.blockTime ?? batch[index]?.blockTime;
        if (typeof blockTime !== 'number' || !Number.isFinite(blockTime)) {
          incomplete = true;
          continue;
        }
        // The stopping page can straddle the boundary. Never include an older
        // transaction merely because it shares a page with current positions.
        if (blockTime * 1000 < notBefore) continue;
        scanned++;
        const proceeds = saleProceeds(tx, address);
        if (proceeds === 'ambiguous') { incomplete = true; continue; }
        if (proceeds === 'none') continue;
        found.set(proceeds.mint, (found.get(proceeds.mint) ?? 0) + proceeds.sol);
      }
    }

    seen += page.length;
    await onProgress?.(`${address.slice(0, 4)}… ${seen} transactions`);

    // history older than the first position cannot contain one of its sales
    const oldest = page.at(-1)?.blockTime;
    if (oldest !== undefined && oldest !== null && oldest * 1000 < notBefore) {
      return { found, scanned, complete: !incomplete };
    }

    before = page.at(-1)?.signature;
    if (page.length < SIGNATURE_PAGE) return { found, scanned, complete: !incomplete };
  }

  // Hitting the request budget does not establish that the remaining history
  // contains no sales. Keep the measured proceeds, but report the short scan.
  return { found, scanned, complete: false };
}

/**
 * Top up any position whose recorded proceeds fall short of the chain.
 *
 * Only ever raises a figure. The scan reaches back a bounded distance, so an
 * older sale can fall outside it — reading that as "this position returned
 * less than we thought" would replace one wrong number with another.
 */
export async function rebuildRealised(
  onProgress?: ProgressFn,
  services: ReconcileServices = reconcileServices,
): Promise<Reconciliation> {
  const expectedEpoch = executionEpoch();
  const wallets = allWallets();
  // Database records are mutable references. Retain the identity of the ledger
  // read at scan start while ordinary trading continues during the RPC reads.
  const positions = db.positions().map(({ mint, symbol, firstBuyAt }) => ({ mint, symbol, firstBuyAt }));

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
      const result = await proceedsByMint(w.address, notBefore, onProgress, services);
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
  await withExecution(async () => {
    assertExecutionEpoch(expectedEpoch);
    for (const snapshot of positions) {
      const pos = db.position(snapshot.mint);
      if (!pos || pos.firstBuyAt !== snapshot.firstBuyAt) continue;
      const onChain = chain.get(pos.mint);
      if (onChain === undefined) continue;
      // Re-read under the execution gate: a sale that completed during the
      // scan may already have raised proceeds beyond the historical result.
      if (onChain <= pos.realisedSol + 0.0001) continue;
      repaired.push({ mint: pos.mint, symbol: pos.symbol, was: pos.realisedSol, now: onChain });
      db.setRealised(pos.mint, onChain);
    }
  });

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
