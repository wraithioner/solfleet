/** Offline public-behavior regressions. No source-code matching or live services. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

import {
  db,
  getTokenInfo,
  readTokenLocks,
  client,
  originalSetTimeout,
  check,
  deferred,
  settle,
  programAccountsFixture,
  mockToken,
} from './fixtures.js';

export async function runTokenBehaviors(): Promise<void> {
  // Multiple pages must contribute to the result; a still-open fifth page is
  // unknown, not a complete partial answer. Fallback invokes the real RPC API.
  {
    const mint = Keypair.generate().publicKey.toBase58();
    const now = Date.now();
    mockToken(mint);
    const stream = Buffer.from(
      fs.readFileSync('scripts/fixtures/streamflow-stream.b64', 'utf8').trim(),
      'base64',
    );
    stream.writeBigUInt64LE(100n, 417);
    stream.writeBigUInt64LE(0n, 17);
    stream.writeBigUInt64LE(BigInt(Math.floor(now / 1000) + 100), 33);
    stream.writeBigUInt64LE(BigInt(Math.floor(now / 1000)), 409);
    const pages: (string | undefined)[] = [];
    globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      pages.push(request.params[1].paginationKey);
      return new Response(
        JSON.stringify({
          result: {
            accounts: [{ account: { data: [stream.toString('base64'), 'base64'] } }],
            paginationKey: pages.length === 1 ? 'next-page' : null,
          },
        }),
      );
    };
    const locks = await readTokenLocks(mint, { now });
    assert.deepEqual(pages, [undefined, 'next-page']);
    assert.equal(locks?.locked.length, 2);
    assert.equal(
      locks?.locked.reduce((sum, item) => sum + item.pct, 0),
      20,
    );
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ result: { accounts: [], paginationKey: 'more' } }));
    };
    assert.equal(await readTokenLocks(mint), undefined);
    assert.equal(calls, 5);
    let fallback = 0;
    client.getProgramAccounts = programAccountsFixture(
      [
        {
          pubkey: Keypair.generate().publicKey,
          account: {
            data: stream,
            owner: PublicKey.default,
            executable: false,
            lamports: 1,
            rentEpoch: 0,
          },
        },
      ],
      () => {
        fallback++;
      },
    );
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { code: -32601, message: 'method unavailable' } }));
    assert.equal((await readTokenLocks(mint, { now }))?.locked.length, 1);
    assert.equal(fallback, 1);
    check(
      'lock scans combine pages, refuse incomplete pagination and fall back on unsupported RPCs',
    );
  }
  {
    db.wipe();
    const mint = Keypair.generate().publicKey.toBase58();
    mockToken(mint);
    const pool = Keypair.generate().publicKey;
    const whale = Keypair.generate().publicKey;
    const accounts = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    client.getTokenLargestAccounts = async () => ({
      context: { slot: 1 },
      value: accounts.map((address, i) => ({
        address,
        amount: i === 0 ? '800' : '200',
        decimals: 0,
        uiAmount: i === 0 ? 800 : 200,
        uiAmountString: i === 0 ? '800' : '200',
      })),
    });
    client.getMultipleParsedAccounts = async () => ({
      context: { slot: 1 },
      value: [pool, whale].map(owner => ({
        data: {
          program: 'spl-token',
          parsed: { info: { mint, owner: owner.toBase58() } },
          space: 165,
        },
        owner: TOKEN_PROGRAM_ID,
        executable: false,
        lamports: 1,
        rentEpoch: 0,
      })),
    });
    for (const program of [
      'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
      '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    ]) {
      client.getMultipleAccountsInfo = async keys =>
        keys.map(key => ({
          owner: key.equals(pool) ? new PublicKey(program) : SystemProgram.programId,
          data: Buffer.alloc(0),
          executable: false,
          lamports: 1,
          rentEpoch: 0,
        }));
      const info = await getTokenInfo(mint, 'solana');
      assert.equal(info.holders?.find(holder => holder.owner === pool.toBase58())?.tag, 'pool');
      assert.equal(info.top10Pct, 20);
      assert.equal(info.top10PctUpperBound, 20);
    }
    check(
      'PumpSwap and Raydium liquidity are excluded from holder concentration after RPC classification',
    );
  }
  {
    const timers: { callback: () => void; ms: number }[] = [];
    // Keep time under the test's control: no multi-second wall-clock waits.
    globalThis.setTimeout = ((callback: () => void, ms = 0) => {
      const entry = { callback, ms };
      timers.push(entry);
      return { unref: () => entry };
    }) as unknown as typeof setTimeout;
    try {
      const pendingLargest = deferred<Awaited<ReturnType<typeof client.getTokenLargestAccounts>>>();
      const fastMint = Keypair.generate().publicKey.toBase58();
      mockToken(fastMint);
      let reads = 0;
      client.getTokenLargestAccounts = () => {
        reads++;
        return pendingLargest.promise;
      };
      let fastDone = false;
      const fast = getTokenInfo(fastMint, 'solana', { fast: true }).then(value => {
        fastDone = true;
        return value;
      });
      await settle();
      assert.equal(reads, 1);
      assert.equal(fastDone, false);
      for (const timer of timers.filter(timer => timer.ms <= 1500)) timer.callback();
      await settle();
      assert.equal(fastDone, true);
      assert.equal((await fast).holdersUnavailable, true);
      timers.length = 0;
      const cardMint = Keypair.generate().publicKey.toBase58();
      mockToken(cardMint);
      client.getTokenLargestAccounts = () => {
        reads++;
        return pendingLargest.promise;
      };
      let cardDone = false;
      const card = getTokenInfo(cardMint, 'solana').then(value => {
        cardDone = true;
        return value;
      });
      await settle();
      for (const timer of timers.filter(timer => timer.ms <= 1500)) timer.callback();
      await settle();
      assert.equal(cardDone, false);
      for (const timer of timers.filter(timer => timer.ms <= 4000)) timer.callback();
      await settle();
      assert.equal(cardDone, true);
      assert.equal((await card).holdersUnavailable, true);
      pendingLargest.resolve({ context: { slot: 1 }, value: [] });
      check(
        'fast token screening still reads chain holders but times out before the human card path',
      );
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  }
}
