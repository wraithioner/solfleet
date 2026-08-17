/**
 * Deliberately tiny logger. The one rule that matters: never log a private key,
 * a mnemonic, or a passphrase. `redact` is applied to everything that goes out.
 */

const SECRET_PATTERNS: RegExp[] = [
  // base58 blobs long enough to be a Solana secret key
  /\b[1-9A-HJ-NP-Za-km-z]{80,90}\b/g,
  // 0x-prefixed 32 byte hex
  /\b0x[a-fA-F0-9]{64}\b/g,
];

export function redact(input: unknown): string {
  let s = typeof input === 'string' ? input : safeStringify(input);
  for (const re of SECRET_PATTERNS) s = s.replace(re, '<redacted>');
  return s;
}

function safeStringify(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function stamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export const log = {
  info(msg: string, meta?: unknown) {
    console.log(`[${stamp()}] ${redact(msg)}${meta === undefined ? '' : ' ' + redact(meta)}`);
  },
  warn(msg: string, meta?: unknown) {
    console.warn(`[${stamp()}] WARN ${redact(msg)}${meta === undefined ? '' : ' ' + redact(meta)}`);
  },
  error(msg: string, meta?: unknown) {
    console.error(`[${stamp()}] ERROR ${redact(msg)}${meta === undefined ? '' : ' ' + redact(meta)}`);
  },
};
