import { PublicKey } from '@solana/web3.js';
import { rpc } from '../chains/solana.js';
import { errMessage } from '../util.js';
import { log } from '../logger.js';

/**
 * What a token's vesting contracts actually say.
 *
 * The concentration number every index reports counts a vesting vault as a
 * holder, because from the outside that is what it is: one address, a large
 * balance. Measured on a live launch that read 63.5% concentrated when 50.2%
 * of it was locked until the year 2095 — supply nobody alive will sell, judged
 * identically to a whale who can hit the book this block.
 *
 * The same read catches the opposite trick. A "vesting stream" whose start and
 * end are one second apart is not vesting, it is an airdrop wearing vesting's
 * clothes: on that same launch, 110 million tokens went to nine wallets in the
 * eight seconds after the coin was created, every one of them emptied on
 * arrival. The launch index scored its insider share at 0%.
 *
 * Streamflow only. It is what pump.fun launches use, and a lock this cannot
 * read is simply not discounted — an unknown locker leaves the number exactly
 * as strict as it is today.
 */
const STREAMFLOW_PROGRAM = 'strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m';

/**
 * Streamflow's stream metadata account, and the fields worth reading.
 *
 * Offsets are fixed by the on-chain layout rather than derived, so they are
 * checked against a captured account in the tests: a known stream's amounts,
 * unlock date and recipient have to land exactly here, or the numbers below
 * are being read out of the wrong bytes.
 */
const STREAM_SIZE = 1104;
const OFF = {
  withdrawnAmount: 17,
  canceledAt: 25,
  endTime: 33,
  recipient: 113,
  mint: 177,
  startTime: 409,
  depositedAmount: 417,
} as const;

/**
 * The shipped answer to "how far away must an unlock be before it stops
 * counting as supply that can land on you".
 *
 * A year is longer than any memecoin's life, so it is the safe place to start
 * — but it is a judgement, not a fact. What the concentration limit is really
 * asking is whether this can reach the book while you are in the position, and
 * for somebody whose positions close in minutes a ninety-day cliff answers no
 * just as firmly. So the line is a setting, and this is only its default.
 */
export const DEFAULT_LOCK_HORIZON_DAYS = 365;
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A schedule this short, and already finished, is a transfer with extra steps.
 *
 * Both halves are needed. Duration alone cannot separate a disguised handout
 * from a distant cliff — the vault holding half a coin until 2095 is also one
 * second long — and a finished schedule alone cannot separate it from vesting
 * that genuinely ran its course. Generous on the duration: real vesting runs
 * for months, and the streams this catches ran for a single second.
 */
export const INSTANT_STREAM_MS = 60 * 1000;

export interface LockedSupply {
  /** Share of total supply this stream is still holding. */
  pct: number;
  /** When it releases. */
  unlockAt: number;
}

export interface TokenLocks {
  /**
   * Every stream still holding supply, and when each one lets go.
   *
   * Per stream rather than one "locked" number, because how far away an unlock
   * has to be before it stops mattering is the operator's setting. Collapsing
   * it here would bake one answer into the read.
   */
  locked: LockedSupply[];
  /** Share of supply handed out through streams that never actually locked. */
  launchDistPct: number;
  /** How many wallets received it. */
  launchDistWallets: number;
}

/** Share of supply that will not unlock for at least `horizonMs`. */
export function lockedBeyond(locked: LockedSupply[], horizonMs: number, now = Date.now()): number {
  return locked.filter((l) => l.unlockAt - now >= horizonMs).reduce((sum, l) => sum + l.pct, 0);
}

/** The furthest unlock among them, for naming a year out loud. */
export function furthestUnlock(locked: LockedSupply[]): number | undefined {
  return locked.length === 0 ? undefined : Math.max(...locked.map((l) => l.unlockAt));
}

export interface Stream {
  deposited: bigint;
  withdrawn: bigint;
  canceledAt: number;
  start: number;
  end: number;
  recipient: string;
}

/** Exported for the layout test, which decodes a captured account. */
export function decodeStream(data: Buffer): Stream | undefined {
  if (data.length < STREAM_SIZE) return undefined;
  return {
    deposited: data.readBigUInt64LE(OFF.depositedAmount),
    withdrawn: data.readBigUInt64LE(OFF.withdrawnAmount),
    canceledAt: Number(data.readBigUInt64LE(OFF.canceledAt)) * 1000,
    start: Number(data.readBigUInt64LE(OFF.startTime)) * 1000,
    end: Number(data.readBigUInt64LE(OFF.endTime)) * 1000,
    recipient: new PublicKey(data.subarray(OFF.recipient, OFF.recipient + 32)).toBase58(),
  };
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`lock lookup exceeded ${ms}ms`)), ms).unref(),
    ),
  ]);
}

/**
 * Read every Streamflow stream against one mint.
 *
 * Undefined on any failure, and the caller treats that as "no lock data" — the
 * discount is not applied and the coin is judged exactly as strictly as it is
 * today. A lock lookup that failed open would hand a free concentration
 * discount to every token whose RPC call happened to time out.
 */
export async function readTokenLocks(
  mint: string,
  { now = Date.now(), timeoutMs = 4000 }: { now?: number; timeoutMs?: number } = {},
): Promise<TokenLocks | undefined> {
  try {
    const conn = rpc();
    /*
     * A deadline, because this sits on the path of a raced entry.
     *
     * Scanning a program's accounts is the slowest query here — measured at
     * 530ms against a paid endpoint, and the one most likely to be far worse
     * against a struggling one. Past the deadline the answer is "unknown",
     * which discounts nothing and leaves the coin judged as it is today. A
     * copy is not worth holding open for it.
     */
    const [supplyRes, accounts] = await withDeadline(
      Promise.all([
        conn.getTokenSupply(new PublicKey(mint)),
        conn.getProgramAccounts(new PublicKey(STREAMFLOW_PROGRAM), {
          filters: [{ dataSize: STREAM_SIZE }, { memcmp: { offset: OFF.mint, bytes: mint } }],
        }),
      ]),
      timeoutMs,
    );

    const supply = BigInt(supplyRes.value.amount);
    if (supply <= 0n) return undefined;

    const streams = accounts
      .map((a) => decodeStream(a.account.data))
      .filter((s): s is Stream => s !== undefined);

    return summariseLocks(streams, supply, now);
  } catch (err) {
    log.warn(`Lock lookup failed for ${mint}: ${errMessage(err)}`);
    return undefined;
  }
}

/**
 * Turn a mint's streams into what the gate needs from them.
 *
 * Pure, and separate from the RPC, because this is the arithmetic that decides
 * whether a coin is bought — and both halves of it are easy to get subtly
 * wrong in a direction that costs money.
 */
export function summariseLocks(streams: Stream[], supply: bigint, now = Date.now()): TokenLocks {
  const locked: LockedSupply[] = [];
  const recipients = new Set<string>();
  let launchDist = 0n;

  const pct = (v: bigint): number => (Number(v) / Number(supply)) * 100;

  for (const s of streams) {
    /*
     * Released, and released the moment it was created. An allocation routed
     * through a vesting program so a dashboard reads it as vested.
     *
     * Counted whether or not the withdrawal has landed — the tokens are the
     * recipient's either way, and waiting for it would miss streams set up
     * seconds before a copy is decided.
     */
    if (s.end - s.start <= INSTANT_STREAM_MS && s.end <= now) {
      launchDist += s.deposited;
      recipients.add(s.recipient);
      continue;
    }

    // canceled went back to the sender, released is already somebody's
    // holding, withdrawn likewise — none of it is still being held back
    if (s.canceledAt > 0 || s.end <= now) continue;
    const outstanding = s.deposited > s.withdrawn ? s.deposited - s.withdrawn : 0n;
    if (outstanding === 0n) continue;

    locked.push({ pct: pct(outstanding), unlockAt: s.end });
  }

  return { locked, launchDistPct: pct(launchDist), launchDistWallets: recipients.size };
}
