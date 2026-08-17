import crypto from 'node:crypto';
import bs58 from 'bs58';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { Keypair } from '@solana/web3.js';
import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem';
import { db, flush } from './db.js';
import { encryptSecret, decryptSecret } from './vault.js';
import type { WalletRecord } from '../types.js';

/**
 * Wallet registry. Every mutation goes through here so that the "exactly one
 * main wallet per chain kind" invariant and the encryption boundary are held in
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

export function mainWallet(kind: 'solana' | 'evm'): WalletRecord | undefined {
  return db.wallets().find((w) => w.kind === kind && w.isMain);
}

export function groups(): string[] {
  const set = new Set<string>();
  for (const w of db.wallets()) for (const g of w.groups) set.add(g);
  return [...set].sort();
}

/**
 * The wallets a batch action should touch: matching kind, not disabled, and in
 * the active group if one is selected.
 */
export function selectWallets(opts: {
  kind?: 'solana' | 'evm';
  group?: string | null;
  includeDisabled?: boolean;
  excludeMain?: boolean;
} = {}): WalletRecord[] {
  const group = opts.group === undefined ? db.settings().activeGroup : opts.group;

  return db.wallets().filter((w) => {
    if (opts.kind && w.kind !== opts.kind) return false;
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

export function evmAccount(w: WalletRecord): PrivateKeyAccount {
  if (w.kind !== 'evm') throw new Error(`${w.label} is not an EVM wallet.`);
  const pk = decryptSecret(w.secret) as `0x${string}`;
  return privateKeyToAccount(pk);
}

/** Plaintext export. Callers must delete the Telegram message afterwards. */
export function exportSecret(w: WalletRecord): string {
  return decryptSecret(w.secret);
}

// ── creating ──────────────────────────────────────────────────────────────────

function nextLabel(kind: 'solana' | 'evm'): string {
  const prefix = kind === 'solana' ? 'SOL' : 'EVM';
  const n = db.wallets().filter((w) => w.kind === kind).length + 1;
  return `${prefix}-${String(n).padStart(2, '0')}`;
}

function insert(rec: Omit<WalletRecord, 'id' | 'createdAt'>): WalletRecord {
  const wallets = db.wallets();

  const existing = wallets.find((w) => w.address.toLowerCase() === rec.address.toLowerCase());
  if (existing) throw new Error(`Wallet ${rec.address} is already in the list as "${existing.label}".`);

  const full: WalletRecord = { ...rec, id: crypto.randomUUID(), createdAt: Date.now() };

  // first wallet of a kind is automatically the main wallet
  if (!wallets.some((w) => w.kind === rec.kind && w.isMain)) full.isMain = true;

  wallets.push(full);
  flush();
  return full;
}

export function generateSolanaWallet(label?: string, groups: string[] = []): WalletRecord {
  const kp = Keypair.generate();
  return insert({
    kind: 'solana',
    address: kp.publicKey.toBase58(),
    label: label || nextLabel('solana'),
    secret: encryptSecret(bs58.encode(kp.secretKey)),
    groups,
    isMain: false,
    disabled: false,
  });
}

export function generateEvmWallet(label?: string, groups: string[] = []): WalletRecord {
  const pk = `0x${crypto.randomBytes(32).toString('hex')}` as `0x${string}`;
  const acct = privateKeyToAccount(pk);
  return insert({
    kind: 'evm',
    address: acct.address,
    label: label || nextLabel('evm'),
    secret: encryptSecret(pk),
    groups,
    isMain: false,
    disabled: false,
  });
}

/**
 * Import from a raw private key. Accepts the two formats wallets actually export:
 * base58 64-byte Solana secret keys (Phantom/Solflare) and 0x hex EVM keys.
 */
export function importPrivateKey(raw: string, label?: string, groups: string[] = []): WalletRecord {
  const key = raw.trim();

  if (/^0x[a-fA-F0-9]{64}$/.test(key)) {
    const acct = privateKeyToAccount(key as `0x${string}`);
    return insert({
      kind: 'evm',
      address: acct.address,
      label: label || nextLabel('evm'),
      secret: encryptSecret(key),
      groups,
      isMain: false,
      disabled: false,
    });
  }

  // bare hex without 0x
  if (/^[a-fA-F0-9]{64}$/.test(key)) return importPrivateKey(`0x${key}`, label, groups);

  // base58 Solana secret key
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(key);
  } catch {
    throw new Error('Unrecognised key format. Expected a base58 Solana key or a 0x-prefixed EVM key.');
  }

  if (decoded.length === 64) {
    const kp = Keypair.fromSecretKey(decoded);
    return insert({
      kind: 'solana',
      address: kp.publicKey.toBase58(),
      label: label || nextLabel('solana'),
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
      label: label || nextLabel('solana'),
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

/** Derive `count` fresh wallets from the stored mnemonic, continuing the index. */
export function deriveWallets(
  kind: 'solana' | 'evm',
  count: number,
  groups: string[] = [],
): WalletRecord[] {
  const mnemonic = getOrCreateMnemonic();
  const used = db.wallets().filter((w) => w.kind === kind && w.derivationIndex !== undefined);
  let index = used.length === 0 ? 0 : Math.max(...used.map((w) => w.derivationIndex!)) + 1;

  const created: WalletRecord[] = [];

  if (kind === 'solana') {
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
  } else {
    for (let n = 0; n < count; n++, index++) {
      const acct = mnemonicToAccount(mnemonic, { addressIndex: index });
      const pk = `0x${Buffer.from(acct.getHdKey().privateKey!).toString('hex')}` as `0x${string}`;
      created.push(
        insert({
          kind: 'evm',
          address: acct.address,
          label: `EVM-HD-${String(index).padStart(2, '0')}`,
          secret: encryptSecret(pk),
          groups,
          isMain: false,
          disabled: false,
          derivationIndex: index,
        }),
      );
    }
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
    if (other.kind === w.kind) other.isMain = other.id === w.id;
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
    const next = db.wallets().find((x) => x.kind === w.kind);
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
