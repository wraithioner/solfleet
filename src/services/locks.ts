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
 * checked against a real account in the tests: the mint, escrow and sender
 * pubkeys of a known stream have to land exactly here or the numbers below are
 * being read out of the wrong bytes.
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
 * Locked past this and the supply is treated as gone rather than concentrated.
 *
 * A year is the line because it is longer than any memecoin's life. The
 * question a concentration limit is really asking is "can this land on me
 * while I am in the position", and for a coin whose median holding time is
 * measured in minutes, a twelve-month cliff answers no as firmly as a burn
 * does. Anything shorter still counts in full — a three-month unlock is real
 * supply arriving, and pretending otherwise is how you get sold into.
 */
export const LOCK_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * A schedule this short, unlocking now, is a transfer with extra steps.
 *
 * Only applied to streams that have already been ruled out as long locks —
 * duration on its own cannot tell a disguised handout from a distant cliff,
 * because both are one second long. Generous on purpose: real vesting is
 * months, and the streams this catches ran for a single second.
 */
export const INSTANT_STREAM_MS = 60 * 1000;

export interface TokenLocks {
  /** Share of supply locked beyond the horizon — not counted as concentration. */
  lockedLongPct: number;
  /** When the longest of those unlocks, for saying so out loud. */
  lockedUntil?: number;
  /** Share of supply handed out through streams that never actually locked. */
  launchDistPct: number;
  /** How many wallets received it. */
  launchDistWallets: number;
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`lock lookup exceeded ${ms}ms`)), ms).unref(),
    ),
  ]);
}

interface Stream {
  deposited: bigint;
  withdrawn: bigint;
  canceledAt: number;
  start: number;
  end: number;
  recipient: string;
}

function decode(data: Buffer): Stream | undefined {
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

/** Exported for the layout test, which decodes a captured account. */
export function decodeStream(data: Buffer): Stream | undefined {
  return decode(data);
}

/**
 * Read every Streamflow stream against one mint.
 *
 * Undefined on any failure, and the caller treats that as "no lock data" — the
 * discount is not applied and the coin is judged exactly as strictly as it is
 * today. A lock lookup that failed open would hand a free concentration
 * discount to every token whose RPC call timed out.
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
     * 530ms against a paid endpoint, and it is the only one that could be
     * far worse against a struggling one. Past the deadline the answer is
     * "unknown", which discounts nothing and leaves the coin judged exactly as
     * it is today; a copy is not worth holding for it.
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
      .map((a) => decode(a.account.data))
      .filter((s): s is Stream => s !== undefined);

    return summariseLocks(streams, supply, now);
  } catch (err) {
    log.warn(`Lock lookup failed for ${mint}: ${errMessage(err)}`);
    return undefined;
  }
}

/**
 * Turn a mint's streams into the two numbers the gate cares about.
 *
 * Pure, and separate from the RPC, because this is the arithmetic that decides
 * whether a coin is bought — and both halves of it are easy to get subtly
 * wrong in a direction that costs money.
 */
export function summariseLocks(
  streams: { deposited: bigint; withdrawn: bigint; canceledAt: number; start: number; end: number; recipient: string }[],
  supply: bigint,
  now = Date.now(),
): TokenLocks {
  let lockedLong = 0n;
  let lockedUntil: number | undefined;
  let launchDist = 0n;
  const recipients = new Set<string>();

  for (const s of streams) {
    const untilUnlock = s.end - now;
    const outstanding =
      s.canceledAt > 0 ? 0n : s.deposited > s.withdrawn ? s.deposited - s.withdrawn : 0n;

    /*
     * Judged on when it unlocks, never on how long it runs.
     *
     * Duration alone reads both of these identically, and they are opposites:
     * the vault holding half this coin's supply until 2095 is a single cliff
     * one second long, and so is a transfer routed through a vesting program
     * to make an allocation look vested. What separates them is the date.
     *
     * So the far-future case is settled first, and nothing that unlocks past
     * the horizon can be counted as a handout — including a canceled one,
     * whose tokens went back to the sender and are already visible there as
     * an ordinary holding.
     */
    if (untilUnlock > LOCK_HORIZON_MS) {
      if (outstanding > 0n) {
        lockedLong += outstanding;
        if (lockedUntil === undefined || s.end > lockedUntil) lockedUntil = s.end;
      }
      continue;
    }

    /*
     * What is left unlocks inside a holding period, so none of it is
     * discounted. The only question is whether it ever locked at all: a
     * schedule that finishes within a minute of starting is a transfer with
     * extra steps, and the wallets it paid are one allocation however many
     * addresses it landed in.
     *
     * Counted whether or not the withdrawal has landed — the tokens are the
     * recipient's either way, and waiting for it would miss the streams set up
     * seconds before a copy is decided.
     */
    if (s.end - s.start <= INSTANT_STREAM_MS) {
      launchDist += s.deposited;
      recipients.add(s.recipient);
    }
  }

  const pct = (v: bigint): number => (Number(v) / Number(supply)) * 100;

  return {
    lockedLongPct: pct(lockedLong),
    lockedUntil,
    launchDistPct: pct(launchDist),
    launchDistWallets: recipients.size,
  };
}
