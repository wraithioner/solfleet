import fs from 'node:fs';
import { config } from './config.js';
import { log } from './logger.js';
import { createBot } from './bot/index.js';
import { autoUnlockIfConfigured, vaultExists, isUnlocked, lockVault } from './store/vault.js';
import { flush } from './store/db.js';
import { enabledChains } from './chains/evm.js';
import { allWallets } from './store/wallets.js';

async function main(): Promise<void> {
  fs.mkdirSync(config.dataDir, { recursive: true });

  log.info('─────────────────────────────────────────────');
  log.info('Multi-wallet command center starting');
  log.info(`Data directory: ${config.dataDir}`);
  log.info(`Solana RPC: ${new URL(config.solana.rpcUrl).host}`);

  const evm = enabledChains();
  log.info(`EVM chains enabled: ${evm.length > 0 ? evm.map((c) => c.name).join(', ') : 'none'}`);

  if (config.solana.rpcUrl.includes('api.mainnet-beta.solana.com')) {
    log.warn('Using the public Solana RPC. Batch operations across many wallets will hit rate limits —');
    log.warn('set SOLANA_RPC_URL to a private endpoint (Helius, QuickNode, Triton) before trading.');
  }

  warnIfStorageIsEphemeral();

  if (await autoUnlockIfConfigured()) {
    log.info('Vault unlocked from VAULT_PASSPHRASE.');
    log.warn('The passphrase is in .env — anyone who can read that file can move your funds.');
  } else if (vaultExists()) {
    log.info('Vault present and locked. Send /unlock <passphrase> in Telegram.');
  } else {
    log.info('No vault yet. Send /start in Telegram to create one.');
  }

  if (isUnlocked()) {
    const wallets = allWallets();
    log.info(
      `Loaded ${wallets.length} wallets ` +
        `(${wallets.filter((w) => w.kind === 'solana').length} Solana, ${wallets.filter((w) => w.kind === 'evm').length} EVM)`,
    );
  }

  const bot = createBot();

  const shutdown = (signal: string) => {
    log.info(`${signal} received — shutting down.`);
    // wipe the master key before the process image can be dumped
    lockVault();
    flush();
    bot.stop();
    setTimeout(() => process.exit(0), 500).unref();
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled promise rejection', reason);
  });

  await bot.start({
    onStart: (info) => {
      log.info(`Bot online as @${info.username}`);
      log.info(`Authorised operator IDs: ${config.ownerIds.join(', ')}`);
      log.info('─────────────────────────────────────────────');
    },
  });
}

/**
 * Shout if the wallet files are sitting on disposable storage.
 *
 * A container filesystem is wiped on every redeploy. If `data/` lives there,
 * the vault and the wallet index go with it — and since the encrypted keys are
 * the only copy, every wallet becomes unspendable the next time the operator
 * pushes a commit. That is an unrecoverable, silent loss of funds, so it is
 * worth being noisy about long before it happens.
 */
function warnIfStorageIsEphemeral(): void {
  // Railway exports these; other container hosts are close enough in spirit
  const onContainerHost = Boolean(
    process.env.RAILWAY_ENVIRONMENT ?? process.env.RAILWAY_PROJECT_ID ?? process.env.RENDER ?? process.env.FLY_APP_NAME,
  );
  if (!onContainerHost) return;

  const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  const onVolume = Boolean(volume && config.dataDir.startsWith(volume));
  if (onVolume) {
    log.info(`Wallet storage is on the persistent volume at ${volume}. Good.`);
    return;
  }

  log.warn('══════════════════════════════════════════════════════════════');
  log.warn('  WALLET STORAGE IS NOT ON A PERSISTENT VOLUME');
  log.warn('');
  log.warn(`  DATA_DIR is ${config.dataDir}, which lives on the container's`);
  log.warn('  disposable filesystem. It is erased on every redeploy and');
  log.warn('  restart, taking vault.json and wallets.json with it.');
  log.warn('');
  log.warn('  The encrypted keys are the ONLY copy. Losing them makes every');
  log.warn('  wallet permanently unspendable — funds included.');
  log.warn('');
  log.warn('  Fix before creating wallets or sending any funds:');
  log.warn('    1. Add a Volume to this service, mount path /data');
  log.warn('    2. Set DATA_DIR=/data in the service variables');
  log.warn('    3. Redeploy');
  log.warn('══════════════════════════════════════════════════════════════');

  if (allWallets().length > 0) {
    log.error(`${allWallets().length} wallets are already stored here. Export their keys NOW, before the next deploy.`);
  }
}

main().catch((err) => {
  log.error('Fatal startup error', err);
  process.exit(1);
});
