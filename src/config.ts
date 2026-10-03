import 'dotenv/config';
import path from 'node:path';

function req(name: string): string {
  const v = process.env[name]?.trim();
  if (!v)
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  return v;
}

function opt(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

function num(name: string, fallback: number, min: number, max: number, integer = false): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) {
    throw new Error(`${name} must be a finite decimal number.`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isSafeInteger(n))) {
    throw new Error(
      `${name} must be ${integer ? 'an integer' : 'a finite number'} between ${min} and ${max}.`,
    );
  }
  return n;
}

function solAmount(name: string, fallback: number, positive = false): number {
  const value = num(name, fallback, positive ? 1e-9 : 0, Number.MAX_SAFE_INTEGER / 1e9);
  if (!Number.isSafeInteger(Math.floor(value * 1e9))) {
    throw new Error(`${name} must convert to a safe integer number of lamports.`);
  }
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['true', '1', 'yes'].includes(raw)) return true;
  if (['false', '0', 'no'].includes(raw)) return false;
  throw new Error(`${name} must be true or false.`);
}

export type ExecutionMode = 'bundle' | 'parallel';

/** Solana's own endpoint: fine for a health check, unusable for real reads. */
const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';

function executionMode(): ExecutionMode {
  const mode = opt('DEFAULT_EXECUTION_MODE', 'parallel');
  if (mode !== 'parallel' && mode !== 'bundle') {
    throw new Error('DEFAULT_EXECUTION_MODE must be parallel or bundle.');
  }
  return mode;
}

function ownerIds(): number[] {
  const ids = req('OWNER_IDS')
    .split(',')
    .map(s => s.trim());
  if (ids.some(id => !/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) {
    throw new Error(
      'OWNER_IDS must contain only positive integer Telegram user IDs, separated by commas.',
    );
  }
  return [...new Set(ids.map(Number))];
}

function jupiterBaseUrl(): string {
  const raw = opt('JUPITER_API_BASE_URL', 'https://api.jup.ag');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('JUPITER_API_BASE_URL must be an HTTPS origin.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error(
      'JUPITER_API_BASE_URL must be an HTTPS origin without credentials, a path, query, or fragment.',
    );
  }
  return url.origin;
}

const jupiterApiKey = opt('JUPITER_API_KEY');
if (/[\r\n]/.test(jupiterApiKey)) throw new Error('JUPITER_API_KEY must not contain line breaks.');

export const config = {
  botToken: req('BOT_TOKEN'),

  ownerIds: ownerIds(),

  solana: {
    rpcUrl: opt('SOLANA_RPC_URL', PUBLIC_RPC),
    sendRpcUrl: opt('SOLANA_SEND_RPC_URL') || opt('SOLANA_RPC_URL', PUBLIC_RPC),
    /**
     * True when no private endpoint was configured.
     *
     * The public endpoint answers `getHealth` in milliseconds and then stalls
     * indefinitely on the account reads every balance screen depends on, so
     * this is worth saying in the interface and not only in the boot log.
     */
    isPublicRpc: !opt('SOLANA_RPC_URL'),
  },

  vault: {
    /**
     * Minutes of inactivity before the key is wiped from memory. Off by
     * default: with no passphrase there is nothing to type to get it back, so
     * locking would just break the bot until it restarts.
     */
    autolockMinutes: num('VAULT_AUTOLOCK_MINUTES', 0, 0, 2_147_483_647 / 60_000),
  },

  trading: {
    slippagePercent: num('DEFAULT_SLIPPAGE_PERCENT', 15, 0, 99.99),
    priorityFeeSol: solAmount('DEFAULT_PRIORITY_FEE_SOL', 0.00005),
    executionMode: executionMode(),
    concurrency: num('EXECUTION_CONCURRENCY', 5, 1, 1_000, true),
    jitoTipSol: solAmount('JITO_TIP_SOL', 0.0001),
  },

  safety: {
    maxBuySolPerWallet: solAmount('MAX_BUY_SOL_PER_WALLET', 5, true),
    requireConfirmation: bool('REQUIRE_CONFIRMATION', true),
  },

  dataDir: path.resolve(process.cwd(), opt('DATA_DIR', './data')),

  jupiter: {
    baseUrl: jupiterBaseUrl(),
    apiKey: jupiterApiKey,
    // The new gateway permits 0.5 requests/sec without a key, or 1/sec on
    // the free keyed plan. Operators on other plans can set their interval.
    requestIntervalMs: num(
      'JUPITER_REQUEST_INTERVAL_MS',
      jupiterApiKey ? 1_000 : 2_000,
      0,
      60_000,
      true,
    ),
  },
} as const;

if (config.ownerIds.length === 0) {
  throw new Error('OWNER_IDS did not contain a valid numeric Telegram user ID.');
}

/** Endpoints for the external services the bot talks to. */
export const endpoints = {
  pumpPortalTradeLocal: 'https://pumpportal.fun/api/trade-local',
  jitoBundles: 'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
  jupiterQuote: `${config.jupiter.baseUrl}/swap/v1/quote`,
  jupiterSwap: `${config.jupiter.baseUrl}/swap/v1/swap`,
  jupiterPrice: `${config.jupiter.baseUrl}/price/v3`,
  jupiterTokens: `${config.jupiter.baseUrl}/tokens/v2/search`,
  dexscreenerTokens: 'https://api.dexscreener.com/latest/dex/tokens',
  /**
   * Every pair for one token on one chain.
   *
   * Chain-scoped because the unscoped lookup mixes in forked chains that reuse
   * the same contract address, which produces wildly wrong prices. Every pair
   * because `tokens/v1` returns only one — measured against this endpoint on
   * the same mints, it answered with a single pool where thirty exist, and the
   * one it picks is the deepest rather than the first. For a graduated pump.fun
   * token the deepest pool is the one created at graduation, so a token that
   * launched five days ago reads as an hour old. Age has to come from the
   * oldest pair, which means seeing all of them.
   */
  dexscreenerPairs: 'https://api.dexscreener.com/token-pairs/v1',
  /**
   * A launch index, used for the three things a single mint cannot tell you:
   * which of its holders are the pool, which are one person behind many
   * wallets, and whether its developer has done this before.
   */
  rugcheck: 'https://api.rugcheck.xyz/v1/tokens',
} as const;

/**
 * DexScreener chain ids searched when someone pastes a non-Solana address.
 * Research only — the bot holds no wallets on these chains.
 */
export const EVM_LOOKUP_CHAINS = [
  'ethereum',
  'base',
  'bsc',
  'arbitrum',
  'polygon',
  'optimism',
  'avalanche',
  'robinhood',
] as const;
