/** Offline wallet safety regressions. All data and Telegram calls are isolated. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Update } from 'grammy/types';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solfleet-wallet-regressions-'));
process.env.BOT_TOKEN = '123:OFFLINE';
process.env.OWNER_IDS = '1';
process.env.DATA_DIR = dataDir;
process.env.VAULT_AUTOLOCK_MINUTES = '0';

// Any accidental network request must fail the regression instead of reaching
// Telegram, an RPC endpoint or a trading service.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Network is disabled in wallet regressions.'); };

const vault = await import('../src/store/vault.js');
const { db, flush } = await import('../src/store/db.js');
const wallets = await import('../src/store/wallets.js');
const state = await import('../src/bot/session.js');
const { createBot } = await import('../src/bot/index.js');

try {
  await vault.initVault('offline regression passphrase');
  const first = wallets.generateSolanaWallet('first');
  const second = wallets.generateSolanaWallet('second');
  const originalSecrets = wallets.allWallets().map((w) => w.secret);

  // A failed later decryption must leave earlier records and disk unchanged.
  second.secret = 'invalid ciphertext';
  flush();
  const beforeFailedReseal = fs.readFileSync(path.join(dataDir, 'wallets.json'), 'utf8');
  assert.throws(() => wallets.resealAll(vault.decryptSecret, (plain) => `replacement:${plain}`));
  assert.equal(first.secret, originalSecrets[0]);
  assert.equal(second.secret, 'invalid ciphertext');
  flush();
  assert.equal(fs.readFileSync(path.join(dataDir, 'wallets.json'), 'utf8'), beforeFailedReseal);
  second.secret = originalSecrets[1]!;
  flush();

  db.raw().mnemonic = 'invalid mnemonic ciphertext';
  assert.throws(() => wallets.resealAll(vault.decryptSecret, (plain) => `replacement:${plain}`));
  assert.deepEqual(wallets.allWallets().map((w) => w.secret), originalSecrets);
  delete db.raw().mnemonic;
  flush();

  // Inject an interruption at each atomic rename in the conversion. The old
  // passphrase and unchanged wallet ciphertext must still recover the vault.
  const originalRename = fs.renameSync;
  for (const failedFile of ['vault.key', 'vault.json']) {
    const beforeWallets = fs.readFileSync(path.join(dataDir, 'wallets.json'), 'utf8');
    const beforeBackup = fs.readFileSync(path.join(dataDir, 'wallets.json.bak'), 'utf8');
    fs.renameSync = ((source, destination) => {
      if (destination.toString() === path.join(dataDir, failedFile)) {
        throw new Error(`Injected ${failedFile} write failure`);
      }
      return originalRename(source, destination);
    }) as typeof fs.renameSync;
    try {
      assert.throws(() => vault.removePassphrase(wallets.resealAll), /Injected/);
    } finally {
      fs.renameSync = originalRename;
    }
    assert.equal(fs.existsSync(path.join(dataDir, `${failedFile}.${process.pid}.tmp`)), false,
      'a failed atomic write leaves no extra copy of its sensitive contents');
    assert.equal(vault.vaultMode(), 'passphrase');
    assert.equal(fs.readFileSync(path.join(dataDir, 'wallets.json'), 'utf8'), beforeWallets);
    assert.equal(fs.readFileSync(path.join(dataDir, 'wallets.json.bak'), 'utf8'), beforeBackup);
    vault.lockVault();
    await vault.unlockVault('offline regression passphrase');
    assert.equal(wallets.solanaKeypair(first).publicKey.toBase58(), first.address);
    assert.equal(wallets.solanaKeypair(second).publicKey.toBase58(), second.address);
  }
  vault.removePassphrase(() => { throw new Error('Conversion must not rewrite wallet ciphertext.'); });
  assert.equal(vault.vaultMode(), 'keyfile');
  assert.deepEqual(wallets.allWallets().map((w) => w.secret), originalSecrets);
  vault.lockVault();
  assert.equal(vault.unlockFromKeyfile(), true);
  assert.equal(wallets.solanaKeypair(first).publicKey.toBase58(), first.address);
  await assert.rejects(() => vault.unlockVault('offline regression passphrase'), /no passphrase/);

  // Solana's base58 alphabet is case-sensitive. Lookup must distinguish even
  // addresses that differ only in case, and imports must not reject one as the
  // other. Use a synthetic existing record so no matching private key is needed.
  const secret = wallets.exportSecret(second);
  const actualAddress = second.address;
  second.address = actualAddress.replace(/[A-HJ-KM-NP-Za-hj-km-np-z]/, (char) =>
    char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase());
  assert.notEqual(second.address, actualAddress);
  assert.equal(wallets.walletByAddress(second.address)?.id, second.id);
  assert.equal(wallets.walletByAddress(actualAddress), undefined);
  const imported = wallets.importPrivateKey(secret, 'case-sensitive import');
  assert.equal(imported.address, actualAddress);
  assert.equal(wallets.walletByAddress(actualAddress)?.id, imported.id);
  wallets.removeWallet(second.id);

  // Expiry is enforced when tapped, even if no new confirmation was staged.
  const expiredId = state.stageConfirmation(1, 'expired', async () => {});
  state.session(1).confirmations.get(expiredId)!.createdAt -= 5 * 60_000 + 1;
  assert.equal(state.takeConfirmation(1, expiredId), undefined);
  const freshId = state.stageConfirmation(1, 'fresh', async () => {});
  assert.equal(state.takeConfirmation(1, freshId)?.label, 'fresh');
  assert.equal(state.takeConfirmation(1, freshId), undefined, 'confirmations are consumed once');

  // Force collisions deterministically. Existing button IDs must keep their
  // original target, including the comparatively small wallet-ID registry.
  const originalRandom = crypto.randomBytes;
  const withRandom = <T>(value: number, run: () => T): T => {
    crypto.randomBytes = ((size: number) => Buffer.alloc(size, value)) as typeof crypto.randomBytes;
    try { return run(); } finally { crypto.randomBytes = originalRandom; }
  };
  const withCollision = <T>(run: () => T): T => {
    let attempt = 0;
    crypto.randomBytes = ((size: number) => Buffer.alloc(size, attempt++ === 0 ? 0 : 1)) as typeof crypto.randomBytes;
    try { return run(); } finally { crypto.randomBytes = originalRandom; }
  };
  const tokenA = withRandom(0, () => state.tokenId('token-a'));
  const tokenB = withCollision(() => state.tokenId('token-b'));
  assert.notEqual(tokenA, tokenB);
  assert.equal(state.mintFromId(tokenA), 'token-a');
  assert.equal(state.mintFromId(tokenB), 'token-b');
  const walletA = withRandom(0, () => state.shortWalletId('wallet-a'));
  const walletB = withCollision(() => state.shortWalletId('wallet-b'));
  assert.notEqual(walletA, walletB);
  assert.equal(state.walletFromShortId(walletA), 'wallet-a');
  assert.equal(state.walletFromShortId(walletB), 'wallet-b');
  const confirmA = withRandom(0, () => state.stageConfirmation(2, 'action-a', async () => {}));
  const confirmB = withCollision(() => state.stageConfirmation(2, 'action-b', async () => {}));
  assert.notEqual(confirmA, confirmB);
  assert.equal(state.takeConfirmation(2, confirmA)?.label, 'action-a');
  assert.equal(state.takeConfirmation(2, confirmB)?.label, 'action-b');

  // Exercise the real middleware and export route using a fake Telegram API.
  const bot = createBot();
  bot.botInfo = { id: 123, is_bot: true, first_name: 'Offline', username: 'offline_bot',
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
    can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
    allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false };
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  bot.api.config.use(async (_previous, method, payload) => {
    const request = payload as Record<string, unknown>;
    calls.push({ method, payload: request });
    const result = method === 'sendMessage' || method === 'editMessageText'
      ? { message_id: 10, date: 0, chat: { id: request.chat_id, type: 'private' }, text: request.text }
      : true;
    return { ok: true, result } as never;
  });
  let updateId = 0;
  const message = (userId: number, privateChat: boolean, text: string): Update => ({
    update_id: ++updateId,
    message: { message_id: updateId, date: 0, from: { id: userId, is_bot: false, first_name: 'User' },
      chat: privateChat ? { id: userId, type: 'private', first_name: 'User' } : { id: -1, type: 'group', title: 'Group' },
      text, entities: [{ offset: 0, length: text.length, type: 'bot_command' }] },
  });
  await bot.handleUpdate(message(2, true, '/help'));
  await bot.handleUpdate(message(1, false, '/help'));
  assert.equal(calls.length, 0, 'unauthorised users and group chats never reach handlers');
  await bot.handleUpdate(message(1, true, '/help'));
  assert.equal(calls.length, 1, 'owner commands still work in private chat');
  calls.length = 0;
  const exportCallback = (privateChat: boolean): Update => ({
    update_id: ++updateId,
    callback_query: { id: `query-${updateId}`, chat_instance: 'offline',
      from: { id: 1, is_bot: false, first_name: 'Owner' },
      data: `export:${state.shortWalletId(first.id)}`,
      message: { message_id: 11, date: 0,
        chat: privateChat ? { id: 1, type: 'private', first_name: 'Owner' } : { id: -1, type: 'group', title: 'Group' } } },
  });
  await bot.handleUpdate(exportCallback(false));
  assert.equal(calls.length, 0, 'a group callback cannot disclose a wallet key');
  await bot.handleUpdate(exportCallback(true));
  assert.equal(calls.some(({ method, payload }) =>
    method === 'sendMessage' && String(payload.text).includes(wallets.exportSecret(first))), true,
  'owner key exports still work in private chat');

  // A missing primary wallet document must recover existing wallets instead
  // of treating the installation as new and overwriting the surviving backup.
  const walletPath = path.join(dataDir, 'wallets.json');
  const walletDocument = fs.readFileSync(walletPath, 'utf8');
  const expectedAddresses = wallets.allWallets().map((w) => w.address);
  fs.rmSync(walletPath);
  db.reload();
  assert.deepEqual(wallets.allWallets().map((w) => w.address), expectedAddresses);
  flush();
  assert.equal(wallets.solanaKeypair(wallets.walletById(first.id)!).publicKey.toBase58(), first.address);
  fs.writeFileSync(walletPath, '{}');
  db.reload();
  assert.deepEqual(wallets.allWallets().map((w) => w.address), expectedAddresses,
    'structurally invalid primary documents also fall back to the validated backup');
  fs.rmSync(walletPath);
  fs.writeFileSync(`${walletPath}.bak`, '{}');
  db.reload();
  assert.throws(() => wallets.allWallets(), 'an invalid backup must not be mistaken for an empty store');
  assert.equal(fs.existsSync(walletPath), false, 'failed recovery writes no new primary');
  assert.equal(fs.readFileSync(`${walletPath}.bak`, 'utf8'), '{}');
  fs.writeFileSync(walletPath, walletDocument);
  fs.writeFileSync(`${walletPath}.bak`, walletDocument);
  db.reload();

  // Recover metadata independently without ever replacing the master key.
  const metadataPath = path.join(dataDir, 'vault.json');
  const keyPath = path.join(dataDir, 'vault.key');
  const metadata = fs.readFileSync(metadataPath, 'utf8');
  const keyFile = fs.readFileSync(keyPath, 'utf8');
  vault.lockVault();
  fs.rmSync(metadataPath);
  assert.equal(vault.openAtBoot(true), 'opened');
  assert.equal(fs.readFileSync(keyPath, 'utf8'), keyFile);
  assert.equal(wallets.solanaKeypair(wallets.walletById(first.id)!).publicKey.toBase58(), first.address);
  vault.lockVault();
  fs.writeFileSync(metadataPath, '{}');
  assert.equal(vault.openAtBoot(true), 'opened', 'invalid primary metadata recovers from backup');
  vault.lockVault();
  fs.rmSync(metadataPath);
  fs.rmSync(`${metadataPath}.bak`);
  assert.throws(() => vault.openAtBoot(true), /metadata is missing/);
  assert.equal(fs.existsSync(metadataPath), false);
  assert.equal(fs.readFileSync(keyPath, 'utf8'), keyFile, 'missing metadata must not overwrite the old key');
  fs.writeFileSync(`${metadataPath}.bak`, '{}');
  assert.throws(() => vault.openAtBoot(true), 'invalid backup metadata must not create a replacement vault');
  assert.equal(fs.existsSync(metadataPath), false);
  assert.equal(fs.readFileSync(keyPath, 'utf8'), keyFile);
  fs.writeFileSync(metadataPath, metadata);
  fs.writeFileSync(`${metadataPath}.bak`, metadata);
  assert.equal(vault.unlockFromKeyfile(), true);

  // A deliberate reset removes recovery copies as well, preventing an old
  // wallet document from coming back under a newly generated encryption key.
  vault.destroyVault();
  db.wipe();
  for (const file of [walletPath, metadataPath, keyPath]) {
    for (const suffix of ['', '.bak', '.corrupt']) assert.equal(fs.existsSync(`${file}${suffix}`), false);
  }
  db.reload();
  assert.deepEqual(wallets.allWallets(), []);
  assert.equal(vault.openAtBoot(false), 'created');

  console.log('Wallet regressions passed: private-chat auth, confirmation expiry, collision-safe IDs, case-sensitive addresses, conversion recovery, validated backups and all-or-nothing resealing.');
} finally {
  vault.lockVault();
  globalThis.fetch = originalFetch;
  fs.rmSync(dataDir, { recursive: true, force: true });
}
