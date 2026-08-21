/** Small helpers shared across the bot. No external deps. */

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Run `fn` over `items` with bounded concurrency, preserving input order in the
 * output. Rejections are not swallowed here — callers wrap fn to capture errors.
 */
export async function pMap<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });

  await Promise.all(workers);
  return results;
}

export async function retry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number; label?: string } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 400;
  let lastErr: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) break;
      // An endpoint that stalled once stalls again: retrying a timeout only
      // multiplies the wait the operator sits through before seeing the error.
      if (isTimeout(err)) break;
      // exponential backoff with jitter, so a batch of wallets does not
      // retry in lockstep and re-hammer the RPC at the same instant
      const delay = base * 2 ** i + Math.random() * base;
      await sleep(delay);
    }
  }
  throw lastErr;
}

/** A request that ran out of time, however the runtime chose to phrase it. */
export function isTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  return /timed? ?out|aborted due to timeout/i.test(err.message);
}

/**
 * Make text safe to put inside a Telegram HTML message.
 *
 * Not cosmetic. Token symbols come from whoever launched the coin, and a
 * symbol containing a `<` makes Telegram reject the whole message as
 * unparseable — so the alert saying a stop-loss fired on that token is the
 * one that never arrives. Anything naming a token, a wallet or an error
 * goes through here.
 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Fetch with a hard timeout so a hung endpoint can't stall a whole batch. */
export async function fetchJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 20_000, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}: ${text.slice(0, 300)}`);
    return text ? (JSON.parse(text) as T) : ({} as T);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchBytes(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Uint8Array> {
  const { timeoutMs = 20_000, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal: ctrl.signal });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status} from ${new URL(url).host}: ${text.slice(0, 300)}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

// ── formatting ────────────────────────────────────────────────────────────────

export function shortAddr(addr: string, lead = 4, tail = 4): string {
  if (addr.length <= lead + tail + 2) return addr;
  return `${addr.slice(0, lead)}…${addr.slice(-tail)}`;
}

export function fmtAmount(n: number, maxDecimals = 6): string {
  if (!Number.isFinite(n)) return '0';
  if (n === 0) return '0';
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (Math.abs(n) < 10 ** -maxDecimals) return n.toExponential(2);
  return Number(n.toFixed(maxDecimals)).toString();
}

export function fmtUsd(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  if (Math.abs(n) < 0.01 && n !== 0) return '<$0.01';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Money at a glance: $205.0M rather than $205,048,692.00.
 *
 * A market cap is read for its order of magnitude, and eight digits plus a
 * decimal point are eight digits of noise between the eye and that. Exact
 * cents still matter below a thousand, where the number is a balance rather
 * than a scale.
 */
export function fmtUsdShort(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—';

  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';

  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return fmtUsd(n);
}

const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';

/**
 * A memecoin price a human can read.
 *
 * These prices live at 1e-6 and below, where `toExponential` gives
 * "2.3300e-6" — technically right and useless at a glance, because the reader
 * has to decode the exponent before they can compare it to anything. The
 * convention every chart site settled on writes the run of zeros as a
 * subscript count: $0.0₅233 is five zeros then 233. The digits that carry the
 * information sit at the end where the eye can reach them.
 */
export function fmtPriceUsd(p: number | undefined): string {
  if (p === undefined || !Number.isFinite(p) || p <= 0) return '—';
  // trailing zeros are noise: $1.50, not $1.5000
  const trim = (v: string) => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);
  if (p >= 1) return `$${trim(p.toFixed(p >= 100 ? 2 : 4))}`;
  if (p >= 0.01) return `$${trim(p.toFixed(4))}`;
  if (p >= 0.0001) return `$${trim(p.toFixed(6))}`;

  // count the zeros between the point and the first significant digit
  const exponent = Math.floor(Math.log10(p));
  const zeros = -exponent - 1;
  const digits = Math.round(p * 10 ** (exponent === 0 ? 0 : -exponent + 2));

  const marker = String(zeros)
    .split('')
    .map((d) => SUBSCRIPT[Number(d)] ?? d)
    .join('');

  return `$0.0${marker}${digits}`;
}

/**
 * A percentage move with its direction shown twice — colour and sign.
 *
 * Rounding decides the emoji, so a move that displays as 0.0% never carries a
 * red or green dot arguing with it.
 */
export function fmtChange(pct: number | undefined): string {
  if (pct === undefined || !Number.isFinite(pct)) return '';
  const rounded = Number(pct.toFixed(1));
  if (rounded === 0) return '⚪️ 0.0%';
  return rounded > 0 ? `🟢 +${rounded.toFixed(1)}%` : `🔴 ${rounded.toFixed(1)}%`;
}

/** A count like 2442 as 2.4K, for places where the magnitude is the point. */
export function fmtCount(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return Math.round(n).toLocaleString('en-US');
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Escape text for Telegram's legacy Markdown parse mode. */
export function esc(s: string): string {
  return s.replace(/([_*`\[\]])/g, '\\$1');
}
