/** Offline safety regressions: no network, signing, store writes or trades. */
import assert from 'node:assert/strict';
process.env.BOT_TOKEN = '123:SAFETY-TEST';
process.env.OWNER_IDS = '1';
process.env.DATA_DIR = '/tmp/solfleet-safety-regressions-unused';
process.env.JUPITER_REQUEST_INTERVAL_MS = '0';

const { Keypair, PublicKey } = await import('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  getMintLen,
  ACCOUNT_SIZE,
  AccountType,
  PAUSABLE_CONFIG_SIZE,
} = await import('@solana/spl-token');
const { assessToken, DEFAULT_SAFETY } = await import('../src/services/safety.js');
const { parseMintAccount, parseTrapExtensions, getMintAuthorities } = await import(
  '../src/services/mintauth.js'
);
const { getTokenInfo } = await import('../src/services/tokeninfo.js');
const { rpc, getMintBalances } = await import('../src/chains/solana.js');
const { bondingCurvePda, PUMP_PROGRAM_ID } = await import('../src/trade/curve.js');
const { summariseLocks, DAY_MS } = await import('../src/services/locks.js');
const { getJupTokenData } = await import('../src/services/jupdata.js');
const { renderTokenCard } = await import('../src/bot/ui.js');

const clean = {
  address: Keypair.generate().publicKey.toBase58(),
  chain: 'solana' as const,
  warnings: [],
  mintAuthority: null,
  freezeAuthority: null,
  top10Pct: 10,
  creatorHoldsPct: 0,
  liquidityUsd: 10_000,
  volume1h: 10_000,
  pairCreatedAt: Date.now() - 600_000,
};
assert.equal(assessToken(clean).safe, true);
for (const key of [
  'top10Pct',
  'creatorHoldsPct',
  'lockerPct',
  'insiderPct',
  'launchDistPct',
  'liquidityUsd',
  'volume1h',
  'pairCreatedAt',
  'devMints',
  'traders5m',
]) {
  for (const bad of [NaN, Infinity, -1, 'unread', null]) {
    assert.equal(
      assessToken({ ...clean, [key]: bad } as never).safe,
      false,
      `${key}=${String(bad)} must refuse`,
    );
  }
}
assert.equal(assessToken({ ...clean, top10Pct: undefined }).safe, false);
assert.equal(
  assessToken({ ...clean, top10Pct: 10, holdersUnavailable: true }).safe,
  false,
  'indexed concentration cannot replace missing chain evidence',
);
assert.equal(
  assessToken({ ...clean, top10Pct: 10, top10PctUpperBound: 50 }).safe,
  false,
  'fragmented unsampled wallets cannot evade the concentration cap',
);
assert.equal(
  assessToken({ ...clean, top10Pct: 10, top10PctUpperBound: 15 }).safe,
  true,
  'a conservative bound below the cap can pass without an exhaustive scan',
);
assert.equal(
  assessToken({ ...clean, creatorHoldsPct: 0, creatorBalanceUnavailable: true }).safe,
  false,
  'indexed creator percentage cannot replace missing chain evidence',
);
assert.equal(assessToken({ ...clean, mintAuthority: undefined }).safe, false);
assert.equal(assessToken({ ...clean, creator: 'known', creatorHoldsPct: undefined }).safe, false);
assert.equal(
  assessToken({
    ...clean,
    isPumpFun: true,
    curveComplete: undefined,
    volume1h: undefined,
    liquidityUsd: undefined,
  }).safe,
  false,
);
assert.equal(assessToken({ ...clean, chain: 'ethereum' }).safe, false);
assert.equal(
  assessToken(
    { ...clean, mintReadUnavailable: true },
    { ...DEFAULT_SAFETY, requireRevokedAuthorities: false },
  ).safe,
  false,
);
assert.equal(
  assessToken(
    { ...clean, token2022: true, traps: undefined },
    { ...DEFAULT_SAFETY, requireRevokedAuthorities: false },
  ).safe,
  false,
);
assert.equal(assessToken({ ...clean, token2022: true, traps: null } as never).safe, false);
assert.equal(assessToken(clean, { ...DEFAULT_SAFETY, maxTop10Pct: NaN }).safe, false);
assert.equal(assessToken(clean, { ...DEFAULT_SAFETY, minLiquidityUsd: null } as never).safe, false);
assert.equal(
  assessToken(clean, { ...DEFAULT_SAFETY, requireRevokedAuthorities: undefined } as never).safe,
  false,
);

const mintData = Buffer.alloc(82);
mintData.writeBigUInt64LE(1000n, 36);
mintData[44] = 0;
mintData[45] = 1;
assert.ok(parseMintAccount(mintData));
for (const [offset, value] of [
  [0, 2],
  [46, 2],
  [45, 0],
] as const) {
  const bad = Buffer.from(mintData);
  if (offset === 45) bad[offset] = value;
  else bad.writeUInt32LE(value, offset);
  assert.equal(parseMintAccount(bad), null);
}
const pausable = Buffer.alloc(getMintLen([ExtensionType.PausableConfig]));
mintData.copy(pausable);
pausable[ACCOUNT_SIZE] = AccountType.Mint;
pausable.writeUInt16LE(ExtensionType.PausableConfig, ACCOUNT_SIZE + 1);
pausable.writeUInt16LE(PAUSABLE_CONFIG_SIZE, ACCOUNT_SIZE + 3);
Keypair.generate()
  .publicKey.toBuffer()
  .copy(pausable, ACCOUNT_SIZE + 5);
const traps = parseTrapExtensions(pausable, TOKEN_2022_PROGRAM_ID.toBase58());
assert.match(traps.join(' '), /pause authority/i);
assert.equal(
  assessToken(
    { ...clean, token2022: true, traps },
    { ...DEFAULT_SAFETY, requireRevokedAuthorities: false },
  ).safe,
  false,
);

const now = Date.now();
const streams = summariseLocks(
  [
    {
      deposited: 500n,
      withdrawn: 0n,
      canceledAt: 0,
      start: now - 365 * DAY_MS,
      end: now + 366 * DAY_MS,
      recipient: 'r',
    },
  ],
  1000n,
  now,
);
assert.equal(
  assessToken({ ...clean, top10Pct: 60, lockerPct: 50, lockedSupply: streams.locked }).safe,
  false,
  'final stream date does not prove unavailable supply',
);
assert.equal(
  assessToken({
    ...clean,
    top10Pct: 40,
    lockerPct: 20,
    lockedSupply: [{ pct: 20, unlockAt: now + 1000 * DAY_MS }],
  }).safe,
  false,
  'an unrelated vault cannot discount a counted locker',
);
const card = renderTokenCard({
  ...clean,
  isPumpFun: true,
  curveComplete: false,
  creator: 'known',
  creatorBalanceUnavailable: true,
  lockedSupply: streams.locked,
});
assert.match(card, /potentially claimable/);
assert.match(card, /No concentration discount/);
assert.match(card, /holds: ❓ unknown/);
assert.throws(() =>
  summariseLocks(
    [{ deposited: 500n, withdrawn: 501n, canceledAt: 0, start: now, end: now + 1, recipient: 'r' }],
    1000n,
    now,
  ),
);

const c = rpc();
const originalFetch = globalThis.fetch;
const mint = clean.address;
const creator = Keypair.generate().publicKey;
const curveKey = bondingCurvePda(mint).toBase58();
let mode: 'lower-index' | 'malformed-index' | 'fragmented-owner' | 'creator' | 'null-jup' =
  'lower-index';
let wrongOwner = false;
const curveData = Buffer.alloc(81);
curveData.writeBigUInt64LE(1000n, 8);
curveData.writeBigUInt64LE(1_000_000_000n, 16);
curveData.writeBigUInt64LE(1000n, 40);
creator.toBuffer().copy(curveData, 49);
const whale = Keypair.generate().publicKey.toBase58();
Object.assign(c, {
  getAccountInfo: async (key: InstanceType<typeof PublicKey>) =>
    key.toBase58() === mint
      ? { owner: wrongOwner ? PublicKey.default : TOKEN_PROGRAM_ID, data: mintData }
      : key.toBase58() === curveKey && mode === 'creator'
        ? { owner: PUMP_PROGRAM_ID, data: curveData }
        : null,
  getTokenSupply: async () => ({
    context: { slot: 1 },
    value: { amount: '1000', decimals: 0, uiAmount: 1000, uiAmountString: '1000' },
  }),
  getTokenLargestAccounts: async () => ({
    context: { slot: 1 },
    value: Array.from({ length: mode === 'fragmented-owner' ? 20 : 1 }, () => ({
      address: Keypair.generate().publicKey,
      amount: mode === 'fragmented-owner' ? '20' : '500',
      decimals: 0,
      uiAmount: null,
      uiAmountString: '0',
    })),
  }),
  getMultipleParsedAccounts: async (keys: unknown[]) => ({
    context: { slot: 1 },
    value: keys.map(() => ({
      data: { parsed: { info: { mint, owner: mode === 'creator' ? creator.toBase58() : whale } } },
    })),
  }),
  getMultipleAccountsInfo: async (keys: unknown[]) => keys.map(() => null),
  getParsedTokenAccountsByOwner: async () => ({
    context: { slot: 1 },
    value: [
      {
        pubkey: Keypair.generate().publicKey,
        account: {
          owner: TOKEN_PROGRAM_ID,
          data: {
            parsed: {
              type: 'account',
              info: {
                mint,
                owner: creator.toBase58(),
                tokenAmount: { amount: '500', decimals: 0 },
              },
            },
          },
        },
      },
    ],
  }),
  getProgramAccounts: async () => [],
});
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.includes('dexscreener'))
    return new Response(
      JSON.stringify([
        {
          chainId: 'solana',
          dexId: 'fixture',
          baseToken: { address: mint, name: 'Fixture', symbol: 'F' },
          liquidity: { usd: 10_000 },
          volume: { h1: 10_000 },
          pairCreatedAt: now - 600_000,
        },
      ]),
    );
  if (url.includes('rugcheck'))
    return new Response(
      JSON.stringify(
        mode === 'malformed-index'
          ? { topHolders: [{}] }
          : mode === 'creator'
            ? {
                creator: creator.toBase58(),
                token: { supply: 1000 },
                creatorBalance: 500,
                topHolders: [
                  { owner: creator.toBase58(), pct: 50 },
                  { owner: whale, pct: 10 },
                ],
                knownAccounts: { [creator.toBase58()]: { type: 'CREATOR' } },
              }
            : { topHolders: [{ owner: whale, pct: 10 }] },
      ),
    );
  if (url.includes('/tokens/v2/search'))
    return new Response(
      JSON.stringify(
        mode === 'null-jup' ? [{ id: mint, audit: { topHoldersPercentage: null } }] : [],
      ),
    );
  if (init?.method === 'POST')
    return new Response(JSON.stringify({ result: { accounts: [], paginationKey: null } }));
  return new Response('{}');
};
try {
  wrongOwner = true;
  assert.equal(
    await getMintAuthorities(mint),
    null,
    'non-token owned data must not read as a mint',
  );
  wrongOwner = false;
  assert.equal(
    (await getMintBalances([creator.toBase58()], mint)).get(creator.toBase58()),
    500n,
    'non-ATA balances are read exhaustively',
  );
  for (const testMode of [
    'lower-index',
    'malformed-index',
    'fragmented-owner',
    'creator',
  ] as const) {
    mode = testMode;
    const info = await getTokenInfo(mint, 'solana');
    assert.equal(assessToken(info).safe, false, `${mode} must refuse`);
    if (mode === 'fragmented-owner') {
      assert.equal(info.top10Pct, 40, 'token accounts must aggregate by wallet');
      assert.equal(
        info.top10PctUpperBound,
        100,
        'every unsampled token is included in the worst-case bound',
      );
    } else
      assert.ok(info.top10Pct! >= 50, 'an index must never reduce observed chain concentration');
    if (mode === 'creator')
      assert.equal(info.creatorHoldsPct, 50, 'creator non-ATA balance remains counted');
  }
  mode = 'null-jup';
  assert.equal(
    (await getJupTokenData(mint))?.topHoldersPct,
    undefined,
    'nullable audit field is unknown, not zero',
  );
} finally {
  globalThis.fetch = originalFetch;
}
console.log('Safety regressions passed (offline).');
