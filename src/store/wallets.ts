import crypto from 'node:crypto';
import bs58 from 'bs58';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { Keypair } from '@solana/web3.js';
import { db, flush } from './db.js';
import { encryptSecret, decryptSecret } from './vault.js';
import type { WalletRecord } from '../types.js';

/**
 * Wallet registry. Every mutation goes through here so that the "exactly one
 * main wallet" invariant and the encryption boundary are held in
 * one place.
 */

const SOLANA_PATH = (i: number) => `m/44'/501'/${i}'/0'`;

// ── reading ───────────────────────────────────────────────────────────────────

export function allWallets(): WalletRecord[] {
  return db.wallets();
}

export function walletById(id: string): WalletRecord | undefined {
  return db.wallets().find((w) => w.id === id);
}

export function walletByAddress(address: string): WalletRecord | undefined {
  const needle = address.toLowerCase();
  return db.wallets().find((w) => w.address.toLowerCase() === needle);
}

export function mainWallet(): WalletRecord | undefined {
  return db.wallets().find((w) => w.isMain);
}

export function groups(): string[] {
  const set = new Set<string>();
  for (const w of db.wallets()) for (const g of w.groups) set.add(g);
  return [...set].sort();
}

/**
 * The wallets a batch action should touch: not disabled, and in
 * the active group if one is selected.
 */
export function selectWallets(opts: {
  group?: string | null;
  includeDisabled?: boolean;
  excludeMain?: boolean;
} = {}): WalletRecord[] {
  const group = opts.group === undefined ? db.settings().activeGroup : opts.group;

  return db.wallets().filter((w) => {
    if (!opts.includeDisabled && w.disabled) return false;
    if (opts.excludeMain && w.isMain) return false;
    if (group && !w.groups.includes(group)) return false;
    return true;
  });
}

// ── signers (the only place plaintext keys are materialised) ──────────────────

export function solanaKeypair(w: WalletRecord): Keypair {
  if (w.kind !== 'solana') throw new Error(`${w.label} is not a Solana wallet.`);
  const secret = decryptSecret(w.secret);
  return Keypair.fromSecretKey(bs58.decode(secret));
}

/** Plaintext export. Callers must delete the Telegram message afterwards. */
export function exportSecret(w: WalletRecord): string {
  return decryptSecret(w.secret);
}

// ── creating ──────────────────────────────────────────────────────────────────

function nextLabel(): string {
  const n = db.wallets().length + 1;
  return `SOL-${String(n).padStart(2, '0')}`;
}

function insert(rec: Omit<WalletRecord, 'id' | 'createdAt'>): WalletRecord {
  const wallets = db.wallets();

  const existing = wallets.find((w) => w.address.toLowerCase() === rec.address.toLowerCase());
  if (existing) throw new Error(`Wallet ${rec.address} is already in the list as "${existing.label}".`);

  const full: WalletRecord = { ...rec, id: crypto.randomUUID(), createdAt: Date.now() };

  // the first wallet is automatically the main wallet
  if (!wallets.some((w) => w.isMain)) full.isMain = true;

  wallets.push(full);
  flush();
  return full;
}

export function generateSolanaWallet(label?: string, groups: string[] = []): WalletRecord {
  const kp = Keypair.generate();
  return insert({
    kind: 'solana',
    address: kp.publicKey.toBase58(),
    label: label || nextLabel(),
    secret: encryptSecret(bs58.encode(kp.secretKey)),
    groups,
    isMain: false,
    disabled: false,
  });
}

/**
 * Import from a raw private key. Accepts both formats Solana wallets export:
 * the base58 64-byte secret key Phantom and Solflare hand out, and the bare
 * 32-byte seed some tools export instead.
 */
export function importPrivateKey(raw: string, label?: string, groups: string[] = []): WalletRecord {
  const key = raw.trim();

  // an EVM key is a plausible paste, and silently failing to parse it as base58
  // would be a confusing way to say "wrong chain"
  if (/^(0x)?[a-fA-F0-9]{64}$/.test(key)) {
    throw new Error('That looks like an EVM private key. This bot holds Solana wallets only.');
  }

  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(key);
  } catch {
    throw new Error('Unrecognised key format. Expected a base58 Solana secret key.');
  }

  if (decoded.length === 64) {
    const kp = Keypair.fromSecretKey(decoded);
    return insert({
      kind: 'solana',
      address: kp.publicKey.toBase58(),
      label: label || nextLabel(),
      secret: encryptSecret(key),
      groups,
      isMain: false,
      disabled: false,
    });
  }

  if (decoded.length === 32) {
    // some tools export only the 32 byte seed
    const kp = Keypair.fromSeed(decoded);
    return insert({
      kind: 'solana',
      address: kp.publicKey.toBase58(),
      label: label || nextLabel(),
      secret: encryptSecret(bs58.encode(kp.secretKey)),
      groups,
      isMain: false,
      disabled: false,
    });
  }

  throw new Error(`Unrecognised key: decoded to ${decoded.length} bytes, expected 32 or 64.`);
}

// ── HD wallet generation ──────────────────────────────────────────────────────

export function getOrCreateMnemonic(): string {
  const stored = db.mnemonic();
  if (stored) return decryptSecret(stored);
  const phrase = bip39.generateMnemonic(128);
  db.setMnemonic(encryptSecret(phrase));
  return phrase;
}

export function setMnemonic(phrase: string): void {
  const clean = phrase.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!bip39.validateMnemonic(clean)) throw new Error('That is not a valid BIP-39 mnemonic.');
  db.setMnemonic(encryptSecret(clean));
}

/**
 * Derive `count` fresh wallets from the stored mnemonic, continuing the index.
 *
 * The path is Phantom's default, so the same phrase restores the same addresses
 * in Phantom or Solflare — the backup is not tied to this bot.
 */
export function deriveWallets(count: number, groups: string[] = []): WalletRecord[] {
  const mnemonic = getOrCreateMnemonic();
  const used = db.wallets().filter((w) => w.derivationIndex !== undefined);
  let index = used.length === 0 ? 0 : Math.max(...used.map((w) => w.derivationIndex!)) + 1;

  const created: WalletRecord[] = [];
  const seed = bip39.mnemonicToSeedSync(mnemonic).toString('hex');

  for (let n = 0; n < count; n++, index++) {
    const { key } = derivePath(SOLANA_PATH(index), seed);
    const kp = Keypair.fromSeed(key);
    created.push(
      insert({
        kind: 'solana',
        address: kp.publicKey.toBase58(),
        label: `SOL-HD-${String(index).padStart(2, '0')}`,
        secret: encryptSecret(bs58.encode(kp.secretKey)),
        groups,
        isMain: false,
        disabled: false,
        derivationIndex: index,
      }),
    );
  }

  return created;
}

// ── mutating ──────────────────────────────────────────────────────────────────

export function renameWallet(id: string, label: string): WalletRecord {
  const w = mustFind(id);
  w.label = label.slice(0, 40);
  flush();
  return w;
}

export function setMain(id: string): WalletRecord {
  const w = mustFind(id);
  for (const other of db.wallets()) {
    other.isMain = other.id === w.id;
  }
  flush();
  return w;
}

export function toggleDisabled(id: string): WalletRecord {
  const w = mustFind(id);
  w.disabled = !w.disabled;
  flush();
  return w;
}

export function addToGroup(id: string, group: string): WalletRecord {
  const w = mustFind(id);
  const g = group.trim().toLowerCase();
  if (g && !w.groups.includes(g)) w.groups.push(g);
  flush();
  return w;
}

export function removeFromGroup(id: string, group: string): WalletRecord {
  const w = mustFind(id);
  w.groups = w.groups.filter((g) => g !== group.trim().toLowerCase());
  flush();
  return w;
}

export function removeWallet(id: string): WalletRecord {
  const w = mustFind(id);
  db.setWallets(db.wallets().filter((x) => x.id !== id));
  // if we just deleted the main wallet, promote the oldest remaining one
  if (w.isMain) {
    const next = db.wallets()[0];
    if (next) setMain(next.id);
  }
  return w;
}

function mustFind(id: string): WalletRecord {
  const w = walletById(id);
  if (!w) throw new Error('That wallet no longer exists.');
  return w;
}

/** Re-encrypt every secret under a new vault key. Used by passphrase rotation. */
export function resealAll(
  decrypt: (blob: string) => string,
  encrypt: (plain: string) => string,
): void {
  const raw = db.raw();
  for (const w of raw.wallets) w.secret = encrypt(decrypt(w.secret));
  if (raw.mnemonic) raw.mnemonic = encrypt(decrypt(raw.mnemonic));
  flush();
}
