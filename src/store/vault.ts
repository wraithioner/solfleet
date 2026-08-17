import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../logger.js';

/**
 * Encrypted key vault.
 *
 * Design notes, because this is the part that loses money if it is wrong:
 *
 *  - The passphrase is stretched with scrypt (N=2^17, r=8, p=1) into a 32 byte
 *    master key. That is deliberately slow — roughly a second — so an attacker
 *    holding the vault file cannot brute force it cheaply.
 *  - Every secret is sealed with AES-256-GCM under a fresh random 12 byte IV.
 *    GCM is authenticated, so tampering with the ciphertext fails loudly at
 *    decrypt time rather than silently producing a garbage key.
 *  - The master key lives only in this module's closure. It is never written to
 *    disk, never logged, and is zeroed on lock.
 *  - A `verifier` blob lets us check a passphrase without touching wallet data.
 */

interface KdfParams {
  N: number;
  r: number;
  p: number;
  keyLen: number;
}

const KDF: KdfParams = { N: 2 ** 17, r: 8, p: 1, keyLen: 32 };
const MAXMEM = 256 * 1024 * 1024;
const VERIFIER_PLAINTEXT = 'multichain-wallet-bot/vault/v1';

interface VaultFile {
  version: 1;
  kdf: KdfParams & { algo: 'scrypt'; salt: string };
  verifier: string;
  createdAt: number;
}

const vaultPath = () => path.join(config.dataDir, 'vault.json');

let masterKey: Buffer | null = null;
let autolockTimer: NodeJS.Timeout | null = null;

// ── key derivation ────────────────────────────────────────────────────────────

function deriveKey(passphrase: string, salt: Buffer, params: KdfParams = KDF): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      passphrase.normalize('NFKC'),
      salt,
      params.keyLen,
      { N: params.N, r: params.r, p: params.p, maxmem: MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key as Buffer)),
    );
  });
}

// ── sealed blob format:  base64( iv[12] || authTag[16] || ciphertext ) ────────

function seal(key: Buffer, plaintext: Buffer | string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext as never)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

function open(key: Buffer, blob: string): Buffer {
  const raw = Buffer.from(blob, 'base64');
  if (raw.length < 29) throw new Error('Sealed blob is truncated or corrupt.');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// ── vault file lifecycle ──────────────────────────────────────────────────────

export function vaultExists(): boolean {
  return fs.existsSync(vaultPath());
}

function readVaultFile(): VaultFile {
  const raw = fs.readFileSync(vaultPath(), 'utf8');
  const parsed = JSON.parse(raw) as VaultFile;
  if (parsed.version !== 1) throw new Error(`Unsupported vault version ${parsed.version}.`);
  return parsed;
}

/** Create a brand new vault. Fails if one already exists — we never overwrite keys. */
export async function initVault(passphrase: string): Promise<void> {
  if (vaultExists()) throw new Error('A vault already exists. Delete data/vault.json only if you have backups.');
  if (passphrase.length < 8) throw new Error('Passphrase must be at least 8 characters.');

  fs.mkdirSync(config.dataDir, { recursive: true });
  const salt = crypto.randomBytes(32);
  const key = await deriveKey(passphrase, salt);

  const file: VaultFile = {
    version: 1,
    kdf: { algo: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, keyLen: KDF.keyLen, salt: salt.toString('base64') },
    verifier: seal(key, VERIFIER_PLAINTEXT),
    createdAt: Date.now(),
  };

  writeAtomic(vaultPath(), JSON.stringify(file, null, 2));
  masterKey = key;
  armAutolock();
  log.info('Vault created and unlocked.');
}

/** Derive the key from a passphrase and hold it in memory. */
export async function unlockVault(passphrase: string): Promise<void> {
  if (!vaultExists()) throw new Error('No vault yet. Create one first.');
  const file = readVaultFile();
  const salt = Buffer.from(file.kdf.salt, 'base64');
  const key = await deriveKey(passphrase, salt, file.kdf);

  try {
    const check = open(key, file.verifier);
    if (check.toString('utf8') !== VERIFIER_PLAINTEXT) throw new Error('mismatch');
  } catch {
    throw new Error('Wrong passphrase.');
  }

  masterKey = key;
  armAutolock();
  log.info('Vault unlocked.');
}

export function lockVault(): void {
  if (masterKey) masterKey.fill(0);
  masterKey = null;
  if (autolockTimer) {
    clearTimeout(autolockTimer);
    autolockTimer = null;
  }
  log.info('Vault locked.');
}

export function isUnlocked(): boolean {
  return masterKey !== null;
}

/** Change the passphrase. Caller supplies a re-seal callback for stored secrets. */
export async function changePassphrase(
  oldPassphrase: string,
  newPassphrase: string,
  reseal: (decrypt: (blob: string) => string, encrypt: (plain: string) => string) => void,
): Promise<void> {
  if (newPassphrase.length < 8) throw new Error('New passphrase must be at least 8 characters.');

  const file = readVaultFile();
  const oldKey = await deriveKey(oldPassphrase, Buffer.from(file.kdf.salt, 'base64'), file.kdf);
  try {
    open(oldKey, file.verifier);
  } catch {
    throw new Error('Current passphrase is wrong.');
  }

  const newSalt = crypto.randomBytes(32);
  const newKey = await deriveKey(newPassphrase, newSalt);

  // Re-encrypt every stored secret under the new key before committing the file,
  // so a crash mid-way cannot orphan the wallets from their vault.
  reseal(
    (blob) => open(oldKey, blob).toString('utf8'),
    (plain) => seal(newKey, plain),
  );

  const next: VaultFile = {
    version: 1,
    kdf: { algo: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, keyLen: KDF.keyLen, salt: newSalt.toString('base64') },
    verifier: seal(newKey, VERIFIER_PLAINTEXT),
    createdAt: file.createdAt,
  };
  writeAtomic(vaultPath(), JSON.stringify(next, null, 2));

  oldKey.fill(0);
  masterKey = newKey;
  armAutolock();
}

// ── the two functions the rest of the app actually uses ───────────────────────

export function encryptSecret(plaintext: string): string {
  const key = requireKey();
  return seal(key, plaintext);
}

export function decryptSecret(blob: string): string {
  const key = requireKey();
  return open(key, blob).toString('utf8');
}

function requireKey(): Buffer {
  if (!masterKey) throw new VaultLockedError();
  touchAutolock();
  return masterKey;
}

export class VaultLockedError extends Error {
  constructor() {
    super('Vault is locked. Send /unlock <passphrase> first.');
    this.name = 'VaultLockedError';
  }
}

// ── auto-lock ─────────────────────────────────────────────────────────────────

function armAutolock(): void {
  touchAutolock();
}

function touchAutolock(): void {
  const minutes = config.vault.autolockMinutes;
  if (!minutes || minutes <= 0) return;
  if (autolockTimer) clearTimeout(autolockTimer);
  autolockTimer = setTimeout(() => {
    log.info(`Auto-locking vault after ${minutes} minutes idle.`);
    lockVault();
  }, minutes * 60_000);
  autolockTimer.unref?.();
}

// ── atomic write ──────────────────────────────────────────────────────────────

export function writeAtomic(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Delete the vault outright and return to the first-run state.
 *
 * Deliberately available while locked: forgetting the passphrase is precisely
 * when starting over is the only option left, and a bot that can only be reset
 * by someone who can already unlock it is no use in that situation. The keys are
 * gone either way — what this changes is whether the operator can carry on.
 */
export function destroyVault(): void {
  lockVault();
  fs.rmSync(vaultPath(), { force: true });
  log.warn('Vault destroyed. Every stored key is now unrecoverable.');
}

/** Unlock automatically when the operator has accepted the risk of VAULT_PASSPHRASE. */
export async function autoUnlockIfConfigured(): Promise<boolean> {
  const pass = config.vault.passphrase;
  if (!pass) return false;
  if (!vaultExists()) {
    await initVault(pass);
    return true;
  }
  await unlockVault(pass);
  return true;
}
