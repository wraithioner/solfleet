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

/**
 * How the master key is obtained.
 *
 * `passphrase` stretches something only the operator knows, so the vault file
 * is useless on its own — but the key cannot survive a restart, and a bot whose
 * container is redeployed asks for it again every single time.
 *
 * `keyfile` keeps a random master key in a file beside the vault. The bot comes
 * back up unlocked and never prompts. The honest trade: anyone who can read the
 * volume can read the keys, so this defends a leaked wallets.json and nothing
 * else.
 */
export type VaultMode = 'passphrase' | 'keyfile';

interface VaultFile {
  version: 1;
  /** Absent on vaults written before keyfile mode existed; those are passphrase. */
  mode?: VaultMode;
  /** Passphrase mode only — there is nothing to stretch in keyfile mode. */
  kdf?: KdfParams & { algo: 'scrypt'; salt: string };
  verifier: string;
  createdAt: number;
}

const vaultPath = () => path.join(config.dataDir, 'vault.json');
const keyfilePath = () => path.join(config.dataDir, 'vault.key');

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

/** Which mode the stored vault uses. Vaults predating keyfile mode are passphrase. */
export function vaultMode(): VaultMode | null {
  if (!vaultExists()) return null;
  return readVaultFile().mode ?? 'passphrase';
}

function requireKdf(file: VaultFile): KdfParams & { algo: 'scrypt'; salt: string } {
  if (!file.kdf) throw new Error('This vault has no passphrase — it opens from its key file.');
  return file.kdf;
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
    mode: 'passphrase',
    kdf: { algo: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, keyLen: KDF.keyLen, salt: salt.toString('base64') },
    verifier: seal(key, VERIFIER_PLAINTEXT),
    createdAt: Date.now(),
  };

  writeAtomic(vaultPath(), JSON.stringify(file, null, 2));
  masterKey = key;
  armAutolock();
  log.info('Vault created and unlocked.');
}

// ── keyfile mode ──────────────────────────────────────────────────────────────

/**
 * Create a vault that needs no passphrase.
 *
 * The master key is random rather than derived, and stored in `vault.key` at
 * 0600 alongside the data it protects. That is the whole point and the whole
 * weakness: the bot can open itself after a restart, and so can anyone holding
 * a copy of the volume.
 */
export function initVaultWithKeyfile(): void {
  if (vaultExists()) throw new Error('A vault already exists. Delete data/vault.json only if you have backups.');

  fs.mkdirSync(config.dataDir, { recursive: true });
  const key = crypto.randomBytes(KDF.keyLen);

  const file: VaultFile = {
    version: 1,
    mode: 'keyfile',
    verifier: seal(key, VERIFIER_PLAINTEXT),
    createdAt: Date.now(),
  };

  // the key lands first: a vault whose key file is missing is unopenable
  writeAtomic(keyfilePath(), key.toString('base64'));
  writeAtomic(vaultPath(), JSON.stringify(file, null, 2));

  masterKey = key;
  log.info('Vault created without a passphrase. It opens from data/vault.key.');
}

/**
 * Load the key file and unlock. Returns false when this vault wants a
 * passphrase; throws when it wants a key file that is not there, because that
 * is a missing-file problem the operator can still fix by restoring it — and
 * silently presenting a locked vault would hide it.
 */
export function unlockFromKeyfile(): boolean {
  if (!vaultExists()) return false;
  const file = readVaultFile();
  if ((file.mode ?? 'passphrase') !== 'keyfile') return false;

  if (!fs.existsSync(keyfilePath())) {
    throw new Error(
      'This vault opens from data/vault.key and that file is missing. Restore it from a backup — without it the stored keys cannot be decrypted.',
    );
  }

  const key = Buffer.from(fs.readFileSync(keyfilePath(), 'utf8').trim(), 'base64');
  if (key.length !== KDF.keyLen) throw new Error('data/vault.key is corrupt: wrong key length.');

  try {
    if (open(key, file.verifier).toString('utf8') !== VERIFIER_PLAINTEXT) throw new Error('mismatch');
  } catch {
    throw new Error('data/vault.key does not match this vault.');
  }

  masterKey = key;
  log.info('Vault opened from its key file.');
  return true;
}

/**
 * Drop the passphrase: re-seal every secret under a fresh random key and write
 * that key to disk. Requires an unlocked vault, so only somebody who already
 * knows the passphrase can trade it away.
 */
export function removePassphrase(
  reseal: (decrypt: (blob: string) => string, encrypt: (plain: string) => string) => void,
): void {
  const oldKey = requireKey();
  if (vaultMode() === 'keyfile') throw new Error('This vault already has no passphrase.');

  const newKey = crypto.randomBytes(KDF.keyLen);

  // secrets are re-sealed before the vault file changes, so a crash in the
  // middle leaves a vault that still opens with the old passphrase
  reseal(
    (blob) => open(oldKey, blob).toString('utf8'),
    (plain) => seal(newKey, plain),
  );

  const file: VaultFile = {
    version: 1,
    mode: 'keyfile',
    verifier: seal(newKey, VERIFIER_PLAINTEXT),
    createdAt: readVaultFile().createdAt,
  };

  writeAtomic(keyfilePath(), newKey.toString('base64'));
  writeAtomic(vaultPath(), JSON.stringify(file, null, 2));

  oldKey.fill(0);
  masterKey = newKey;
  if (autolockTimer) {
    clearTimeout(autolockTimer);
    autolockTimer = null;
  }
  log.warn('Passphrase removed. The vault now opens from data/vault.key on this volume.');
}

/**
 * Convert a passphrase vault that holds nothing worth decrypting.
 *
 * A vault created but never used has no secrets sealed under its key, so there
 * is nothing to re-encrypt and no reason to make the operator produce a
 * passphrase they only set a moment ago. Returns false when the vault does hold
 * secrets — those need one real unlock before they can be moved.
 */
export function convertEmptyVaultToKeyfile(hasSecrets: boolean): boolean {
  if (vaultMode() !== 'passphrase' || hasSecrets) return false;

  const key = crypto.randomBytes(KDF.keyLen);
  const file: VaultFile = {
    version: 1,
    mode: 'keyfile',
    verifier: seal(key, VERIFIER_PLAINTEXT),
    createdAt: readVaultFile().createdAt,
  };

  writeAtomic(keyfilePath(), key.toString('base64'));
  writeAtomic(vaultPath(), JSON.stringify(file, null, 2));

  masterKey = key;
  log.info('Empty vault converted — no passphrase needed from here on.');
  return true;
}

/** Derive the key from a passphrase and hold it in memory. */
export async function unlockVault(passphrase: string): Promise<void> {
  if (!vaultExists()) throw new Error('No vault yet. Create one first.');
  const file = readVaultFile();
  const kdf = requireKdf(file);
  const salt = Buffer.from(kdf.salt, 'base64');
  const key = await deriveKey(passphrase, salt, kdf);

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

/**
 * Unlock an old passphrase vault and immediately convert it.
 *
 * The only remaining reason to type a passphrase: a vault created before
 * passphrases were dropped still has its secrets sealed under one, and moving
 * them needs the key that opens them. This is asked once and then never again.
 */
export async function unlockAndConvert(
  passphrase: string,
  reseal: (decrypt: (blob: string) => string, encrypt: (plain: string) => string) => void,
): Promise<void> {
  await unlockVault(passphrase);
  removePassphrase(reseal);
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
    super('The vault is not open. Send /start.');
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
  // the key file goes too, or the next vault inherits a stale one
  fs.rmSync(keyfilePath(), { force: true });
  log.warn('Vault destroyed. Every stored key is now unrecoverable.');
}

/**
 * Bring the vault up at boot without asking anything.
 *
 * Returns what the caller has to tell the operator: nothing at all in the
 * normal case, and only in the one case that cannot be resolved automatically —
 * an old vault whose secrets are still sealed under a passphrase.
 */
export function openAtBoot(hasSecrets: boolean): 'opened' | 'created' | 'needs-passphrase' {
  if (!vaultExists()) {
    initVaultWithKeyfile();
    return 'created';
  }
  if (unlockFromKeyfile()) return 'opened';
  if (convertEmptyVaultToKeyfile(hasSecrets)) return 'opened';
  return 'needs-passphrase';
}
