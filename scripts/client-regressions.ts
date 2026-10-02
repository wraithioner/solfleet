/** Offline gateway and startup configuration checks. Every transport is stubbed. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

process.env.BOT_TOKEN = '123:OFFLINE';
process.env.OWNER_IDS = '1';
process.env.JUPITER_API_KEY = '';
process.env.JUPITER_API_BASE_URL = 'https://api.jup.ag';
process.env.JUPITER_REQUEST_INTERVAL_MS = '0';

const { createJupiterClient, fetchJupiterJson } = await import('../src/services/jupiter-client.js');
const { endpoints } = await import('../src/config.js');
const originalFetch = globalThis.fetch;
let passed = 0;
function ok(name: string): void { passed++; console.log(`  ✓ ${name}`); }

const baseEnv: NodeJS.ProcessEnv = {
  ...process.env,
  BOT_TOKEN: '123:OFFLINE', OWNER_IDS: '1', VAULT_AUTOLOCK_MINUTES: '0',
  DEFAULT_SLIPPAGE_PERCENT: '', DEFAULT_PRIORITY_FEE_SOL: '', DEFAULT_EXECUTION_MODE: '',
  EXECUTION_CONCURRENCY: '', JITO_TIP_SOL: '', MAX_BUY_SOL_PER_WALLET: '', REQUIRE_CONFIRMATION: '',
  JUPITER_API_BASE_URL: '', JUPITER_API_KEY: '', JUPITER_REQUEST_INTERVAL_MS: '',
};
const configUrl = new URL('../src/config.ts', import.meta.url).href;
function configProbe(overrides: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `try { const { config, endpoints } = await import(${JSON.stringify(configUrl)}); console.log(JSON.stringify({ config, endpoints })); } catch (err) { console.error(err.message); process.exitCode = 1; }`,
  ], { env: { ...baseEnv, ...overrides }, encoding: 'utf8', timeout: 10_000 });
}

try {
  const defaults = configProbe();
  assert.equal(defaults.status, 0, defaults.stderr);
  const parsed = JSON.parse(defaults.stdout) as { config: { jupiter: { baseUrl: string; requestIntervalMs: number } }; endpoints: Record<string, string> };
  assert.equal(parsed.config.jupiter.baseUrl, 'https://api.jup.ag');
  assert.equal(parsed.config.jupiter.requestIntervalMs, 2_000);
  assert.equal(parsed.endpoints.jupiterQuote, 'https://api.jup.ag/swap/v1/quote');
  assert.equal(parsed.endpoints.jupiterTokens, 'https://api.jup.ag/tokens/v2/search');
  const keyed = configProbe({ JUPITER_API_KEY: 'offline-key' });
  assert.equal(keyed.status, 0, keyed.stderr);
  assert.equal(JSON.parse(keyed.stdout).config.jupiter.requestIntervalMs, 1_000);
  ok('current gateway defaults honor the keyless and keyed rate allowances');

  const invalid: Array<[string, string]> = [
    ['DEFAULT_SLIPPAGE_PERCENT', '100'], ['DEFAULT_SLIPPAGE_PERCENT', 'Infinity'],
    ['DEFAULT_PRIORITY_FEE_SOL', '-1'], ['DEFAULT_PRIORITY_FEE_SOL', 'NaN'],
    ['DEFAULT_PRIORITY_FEE_SOL', '1e300'], ['DEFAULT_PRIORITY_FEE_SOL', '10000000'],
    ['JITO_TIP_SOL', '-0.1'], ['MAX_BUY_SOL_PER_WALLET', '0'], ['MAX_BUY_SOL_PER_WALLET', '1e-10'],
    ['MAX_BUY_SOL_PER_WALLET', 'not-a-number'], ['EXECUTION_CONCURRENCY', '0'],
    ['EXECUTION_CONCURRENCY', '1.5'], ['EXECUTION_CONCURRENCY', '1001'],
    ['DEFAULT_EXECUTION_MODE', 'paralell'], ['REQUIRE_CONFIRMATION', 'tru'],
    ['OWNER_IDS', '1,invalid'], ['OWNER_IDS', '9007199254740992'],
    ['VAULT_AUTOLOCK_MINUTES', '-1'], ['JUPITER_REQUEST_INTERVAL_MS', '-1'],
    ['JUPITER_REQUEST_INTERVAL_MS', '1.5'], ['JUPITER_REQUEST_INTERVAL_MS', '60001'],
    ['JUPITER_API_BASE_URL', 'http://api.jup.ag'],
    ['JUPITER_API_BASE_URL', 'https://user:password@api.jup.ag'],
    ['JUPITER_API_BASE_URL', 'https://api.jup.ag/private'],
    ['JUPITER_API_BASE_URL', 'https://api.jup.ag/?key=oops'],
    ['JUPITER_API_KEY', 'key\ninjection'],
  ];
  for (const [field, value] of invalid) {
    const probe = configProbe({ [field]: value });
    assert.equal(probe.status, 1, `${field}=${value} was accepted: ${probe.stdout} ${probe.stderr}`);
    assert.ok(probe.stderr.includes(field), `${field} should be named in the startup error.`);
  }
  ok('invalid money, slippage, concurrency, modes, owners, booleans and gateway configuration fail startup');

  const zeros = configProbe({ DEFAULT_PRIORITY_FEE_SOL: '0', JITO_TIP_SOL: '0', DEFAULT_SLIPPAGE_PERCENT: '0',
    MAX_BUY_SOL_PER_WALLET: '0.000000001', DEFAULT_EXECUTION_MODE: 'bundle', REQUIRE_CONFIRMATION: 'false',
    JUPITER_REQUEST_INTERVAL_MS: '0', OWNER_IDS: '1,2,1' });
  assert.equal(zeros.status, 0, zeros.stderr);
  const zeroConfig = JSON.parse(zeros.stdout).config;
  assert.equal(zeroConfig.trading.priorityFeeSol, 0);
  assert.equal(zeroConfig.trading.jitoTipSol, 0);
  assert.deepEqual(zeroConfig.ownerIds, [1, 2]);
  ok('explicit zero fees, zero slippage, one-lamport cap and offline interval remain valid');

  const observations: Array<{ url: string; headers: Headers; redirect: RequestInit['redirect']; at: number }> = [];
  globalThis.fetch = async (input, init) => {
    observations.push({ url: String(input), headers: new Headers(init?.headers), redirect: init?.redirect, at: performance.now() });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const authenticated = createJupiterClient({ baseUrl: 'https://proxy.example:8443', apiKey: 'offline-key', requestIntervalMs: 0 });
  await authenticated('https://proxy.example:8443/swap/v1/quote', {
    headers: [['Content-Type', 'application/json'], ['x-api-key', 'caller-key']], redirect: 'follow',
  });
  assert.equal(observations[0]!.headers.get('x-api-key'), 'offline-key');
  assert.equal(observations[0]!.headers.get('content-type'), 'application/json');
  assert.equal(observations[0]!.redirect, 'error');
  await assert.rejects(authenticated('https://other.example/swap/v1/quote'), /configured HTTPS origin/);
  await assert.rejects(authenticated('http://proxy.example:8443/swap/v1/quote'), /configured HTTPS origin/);
  await assert.rejects(authenticated('https://user:password@proxy.example:8443/swap/v1/quote'), /configured HTTPS origin/);
  assert.equal(observations.length, 1);
  await fetchJupiterJson(endpoints.jupiterPrice, { headers: { 'x-api-key': 'stale-key' } });
  assert.equal(observations[1]!.headers.has('x-api-key'), false);
  ok('API keys stay on the configured HTTPS origin, caller headers cannot replace them, redirects are refused');

  globalThis.fetch = async () => new Response('rejected key offline-key; repeated offline-key', { status: 401 });
  await assert.rejects(authenticated('https://proxy.example:8443/swap/v1/quote'), (err: unknown) =>
    err instanceof Error && /HTTP 401/.test(err.message) && err.message.includes('[redacted]') && !err.message.includes('offline-key'));
  globalThis.fetch = async () => new Response('offline-key', { status: 200 });
  await assert.rejects(authenticated('https://proxy.example:8443/swap/v1/quote'), (err: unknown) =>
    err instanceof SyntaxError && !`${err.message}\n${err.stack}`.includes('offline-key'));
  globalThis.fetch = async (input, init) => {
    observations.push({ url: String(input), headers: new Headers(init?.headers), redirect: init?.redirect, at: performance.now() });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  ok('HTTP and malformed JSON error bodies cannot echo the API key into application logs');

  observations.length = 0;
  const paced = createJupiterClient({ baseUrl: 'https://api.jup.ag', apiKey: '', requestIntervalMs: 35 });
  await Promise.all([
    paced(endpoints.jupiterQuote), paced(endpoints.jupiterSwap), paced(endpoints.jupiterPrice), paced(endpoints.jupiterTokens),
  ]);
  assert.equal(observations.length, 4);
  for (let i = 1; i < observations.length; i++) {
    assert.ok(observations[i]!.at - observations[i - 1]!.at >= 33, 'different APIs must share the dispatch interval');
  }
  ok('quote, swap, price and token calls share one paced dispatch queue');

  observations.length = 0;
  const expiry = createJupiterClient({ baseUrl: 'https://api.jup.ag', apiKey: '', requestIntervalMs: 60 });
  await expiry(endpoints.jupiterQuote);
  const expired = [1, 2, 3].map(() => assert.rejects(expiry(endpoints.jupiterSwap, { timeoutMs: 15 }), (err: unknown) =>
    err instanceof Error && err.name === 'TimeoutError'));
  const live = expiry(endpoints.jupiterPrice, { timeoutMs: 500 });
  await Promise.all([...expired, live]);
  assert.deepEqual(observations.map((o) => o.url), [endpoints.jupiterQuote, endpoints.jupiterPrice]);
  assert.ok(observations[1]!.at - observations[0]!.at < 140, 'expired queue entries must not consume future slots');
  ok('queue wait consumes the timeout budget and expired requests never dispatch or reserve slots');

  observations.length = 0;
  const cancel = createJupiterClient({ baseUrl: 'https://api.jup.ag', apiKey: '', requestIntervalMs: 40 });
  await cancel(endpoints.jupiterQuote);
  const controller = new AbortController();
  const cancellation = assert.rejects(cancel(endpoints.jupiterSwap, { signal: controller.signal }), (err: unknown) =>
    err instanceof Error && err.name === 'AbortError');
  controller.abort();
  await Promise.all([cancellation, cancel(endpoints.jupiterTokens)]);
  assert.deepEqual(observations.map((o) => o.url), [endpoints.jupiterQuote, endpoints.jupiterTokens]);
  ok('caller cancellation removes queued work without consuming a dispatch slot');

  const unpaced = createJupiterClient({ baseUrl: 'https://api.jup.ag', apiKey: '', requestIntervalMs: 0 });
  globalThis.fetch = async () => new Promise<Response>(() => {});
  await assert.rejects(unpaced(endpoints.jupiterPrice, { timeoutMs: 15 }), (err: unknown) => err instanceof Error && err.name === 'TimeoutError');
  globalThis.fetch = async () => ({ ok: true, status: 200, text: () => new Promise<string>(() => {}) }) as Response;
  await assert.rejects(unpaced(endpoints.jupiterPrice, { timeoutMs: 15 }), (err: unknown) => err instanceof Error && err.name === 'TimeoutError');
  ok('the same deadline covers stalled fetches and stalled response bodies');

  globalThis.fetch = async () => new Response('rate limited', { status: 429 });
  await assert.rejects(unpaced(endpoints.jupiterQuote), /HTTP 429/);
  globalThis.fetch = async () => new Response('{broken JSON', { status: 200 });
  await assert.rejects(unpaced(endpoints.jupiterTokens), SyntaxError);
  await assert.rejects(unpaced(endpoints.jupiterTokens, { timeoutMs: 0 }), /timeout/);
  ok('HTTP, malformed JSON and invalid request budgets remain visible failures');
} finally {
  globalThis.fetch = originalFetch;
}

console.log(`\n${passed} offline client and configuration regressions passed.`);
