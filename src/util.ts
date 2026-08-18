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

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Escape text for Telegram's legacy Markdown parse mode. */
export function esc(s: string): string {
  return s.replace(/([_*`\[\]])/g, '\\$1');
}
