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

main().catch((err) => {
  log.error('Fatal startup error', err);
  process.exit(1);
});
