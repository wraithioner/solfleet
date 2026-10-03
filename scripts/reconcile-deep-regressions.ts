/** Adversarial history accounting fixtures. No RPC, signing, or broadcasts. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bs58 from 'bs58';
import {
  PublicKey,
  type ConfirmedSignatureInfo,
  type ParsedTransactionWithMeta,
} from '@solana/web3.js';
import type { ReconcileServices } from '../src/services/reconcile.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solfleet-reconcile-deep-'));
process.env.BOT_TOKEN = '123:OFFLINE_TEST';
process.env.OWNER_IDS = '1';
process.env.DATA_DIR = dataDir;
const { proceedsByMint, rebuildRealised } = await import('../src/services/reconcile.js');
const { db } = await import('../src/store/db.js');
const { withExecution, withExecutionMaintenance } = await import('../src/services/execution.js');

const key = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
const owner = key(10).toBase58();
const input = key(11).toBase58();
const poolInput = key(12).toBase58();
const output = key(13).toBase58();
const poolOutput = key(14).toBase58();
const mint = key(15).toBase58();
const outsider = key(16).toBase58();
const otherMint = key(17).toBase58();
const WSOL = 'So11111111111111111111111111111111111111112';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SYSTEM = '11111111111111111111111111111111';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const RENT = 2_039_280;
const FEE = 5000;
const NET = (100_000_000 - FEE) / 1e9;
const swapIx = (program = PUMP, name = 'sell') => ({
  programId: new PublicKey(program),
  accounts: [owner, input, output, mint, WSOL].map(s => new PublicKey(s)),
  // An Anchor discriminator plus two u64 swap arguments.
  data: bs58.encode(
    Buffer.concat([
      createHash('sha256').update(`global:${name}`).digest().subarray(0, 8),
      Buffer.alloc(16),
    ]),
  ),
});
const tokenIx = (type: string, info: object) => ({
  program: 'spl-token',
  programId: new PublicKey(TOKEN),
  parsed: { type, info },
});
const inputTransfer = (amount = '100000000') =>
  tokenIx('transferChecked', {
    source: input,
    destination: poolInput,
    authority: owner,
    mint,
    tokenAmount: { amount, decimals: 6, uiAmount: Number(amount) / 1e6 },
  });
const balance = (
  accountIndex: number,
  tokenMint: string,
  tokenOwner: string,
  amount: string,
  decimals = 6,
) => ({
  accountIndex,
  mint: tokenMint,
  owner: tokenOwner,
  uiTokenAmount: {
    amount,
    decimals,
    uiAmount: Number(amount) / 10 ** decimals,
    uiAmountString: amount,
  },
});
const sale = (): ParsedTransactionWithMeta =>
  ({
    blockTime: 10_000,
    slot: 1,
    transaction: {
      signatures: [],
      message: {
        accountKeys: [owner, input, poolInput, output, poolOutput, outsider].map((s, i) => ({
          pubkey: new PublicKey(s),
          signer: i === 0,
          writable: true,
          source: 'transaction',
        })),
        instructions: [swapIx()],
        recentBlockhash: owner,
      },
    },
    meta: {
      err: null,
      fee: FEE,
      preTokenBalances: [balance(1, mint, owner, '100000000'), balance(2, mint, outsider, '0')],
      postTokenBalances: [balance(1, mint, owner, '0'), balance(2, mint, outsider, '100000000')],
      preBalances: [1e9, RENT, RENT, RENT, 1e9, 1e9],
      postBalances: [1e9 + 100_000_000 - FEE, RENT, RENT, RENT, 1e9, 1e9],
      innerInstructions: [{ index: 0, instructions: [inputTransfer()] }],
    },
  }) as unknown as ParsedTransactionWithMeta;
const wrappedSale = (program = JUPITER, oldWrapped = 0): ParsedTransactionWithMeta => {
  const tx = sale();
  tx.transaction.message.instructions = [
    swapIx(program, program === JUPITER ? 'route' : 'sell'),
    tokenIx('closeAccount', { account: output, destination: owner, owner }),
  ];
  tx.meta!.preTokenBalances!.push(balance(3, WSOL, owner, String(oldWrapped), 9));
  tx.meta!.preBalances[3] = RENT + oldWrapped;
  tx.meta!.postBalances[3] = 0;
  tx.meta!.postBalances[0] = 1e9 + 100_000_000 + RENT + oldWrapped - FEE;
  tx.meta!.innerInstructions![0]!.instructions.push(
    tokenIx('transferChecked', {
      source: poolOutput,
      destination: output,
      authority: outsider,
      mint: WSOL,
      tokenAmount: { amount: '100000000', decimals: 9, uiAmount: 0.1 },
    }),
  );
  return tx;
};
const signature = (name: string, blockTime: number | null = 10_000): ConfirmedSignatureInfo => ({
  signature: name,
  slot: 1,
  err: null,
  memo: null,
  blockTime,
  confirmationStatus: 'confirmed',
});
const service = (
  pages: ConfirmedSignatureInfo[][],
  parse: (name: string) => ParsedTransactionWithMeta | null,
  parsedNames: string[] = [],
): ReconcileServices => {
  let page = 0;
  return {
    rpc: () => ({
      getSignaturesForAddress: async () => pages[page++] ?? [],
      getParsedTransactions: async names =>
        names.map(name => {
          parsedNames.push(name);
          return parse(name);
        }),
    }),
    paced: async fn => fn(),
  };
};
const scan = (tx: ParsedTransactionWithMeta) =>
  proceedsByMint(
    owner,
    9_000_000,
    undefined,
    service([[signature('fixture')]], () => tx),
  );
const closeTo = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
let passed = 0;
const check = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};
const rejects = async (tx: ParsedTransactionWithMeta, name: string) => {
  const result = await scan(tx);
  assert.equal(result.complete, false, 'unattributable accounting cannot be complete');
  assert.equal(result.found.size, 0, 'ambiguous SOL must never raise proceeds');
  check(name);
};

try {
  {
    const result = await scan(sale());
    assert.equal(result.complete, true);
    closeTo(result.found.get(mint)!, NET);
    check('a supported native Pump sell preserves measured return net of fees');
  }
  {
    const tx = sale();
    tx.transaction.message.instructions = [
      inputTransfer(),
      {
        programId: new PublicKey(SYSTEM),
        program: 'system',
        parsed: {
          type: 'transfer',
          info: { source: outsider, destination: owner, lamports: 100_000_000 },
        },
      },
    ];
    tx.meta!.innerInstructions = [];
    await rejects(tx, 'token transfer plus unrelated SOL funding is not a sale');
  }
  {
    const tx = sale();
    tx.transaction.message.instructions = [swapIx(PUMP, 'collect_creator_fee')];
    await rejects(tx, 'a trade program called for another operation cannot prove a sale');
  }
  {
    const tx = sale();
    tx.transaction.message.instructions.push(inputTransfer());
    tx.meta!.innerInstructions = [];
    await rejects(tx, 'a recognized swap does not authorize an unrelated token debit');
  }
  {
    const tx = sale();
    tx.meta!.innerInstructions![0]!.instructions = [inputTransfer('99000000')];
    await rejects(tx, 'the attributed CPI debit must explain the entire owned-token decrease');
  }
  {
    const tx = sale();
    tx.meta!.preTokenBalances!.push(balance(3, otherMint, owner, '1', 0));
    tx.meta!.postTokenBalances!.push(balance(3, otherMint, owner, '0', 0));
    await rejects(tx, 'proceeds are never split using incomparable quantities from two mints');
  }
  {
    const tx = sale();
    tx.meta!.postTokenBalances!.push(balance(3, otherMint, owner, '1000000'));
    await rejects(tx, 'a transaction acquiring another token leaves SOL valuation ambiguous');
  }
  {
    const tx = sale();
    tx.meta!.innerInstructions = null;
    await rejects(tx, 'missing CPI evidence cannot produce a complete repair');
  }
  {
    const tx = sale();
    tx.transaction.message.accountKeys[0]!.signer = false;
    await rejects(tx, 'the proceeds wallet must participate as the swap signer');
  }
  {
    const tx = sale();
    tx.meta!.preTokenBalances![0]!.owner = undefined;
    await rejects(tx, 'missing token ownership metadata is explicitly incomplete');
  }
  for (const program of [JUPITER, PUMP_AMM]) {
    const result = await scan(wrappedSale(program));
    assert.equal(result.complete, true);
    closeTo(result.found.get(mint)!, NET);
    check(
      `a supported ${program === JUPITER ? 'Jupiter' : 'PumpSwap'} sale excludes refunded WSOL rent`,
    );
  }
  {
    const result = await scan(wrappedSale(JUPITER, 500_000_000));
    assert.equal(result.complete, true);
    closeTo(result.found.get(mint)!, NET);
    check('redeeming pre-existing WSOL cannot inflate a new sale');
  }
  {
    const tx = wrappedSale();
    tx.meta!.preTokenBalances = tx.meta!.preTokenBalances!.filter(b => b.mint !== WSOL);
    tx.meta!.preBalances[3] = 0;
    tx.meta!.postBalances[0] = 1e9 + 100_000_000 - FEE;
    tx.transaction.message.instructions.unshift(
      tokenIx('initializeAccount3', { account: output, mint: WSOL, owner }),
    );
    tx.meta!.innerInstructions![0]!.index = 1;
    const result = await scan(tx);
    assert.equal(result.complete, true);
    closeTo(result.found.get(mint)!, NET);
    check('a temporary WSOL account absent from balance snapshots uses initialization evidence');
  }
  {
    const tx = wrappedSale();
    tx.meta!.innerInstructions![0]!.instructions = [inputTransfer()];
    await rejects(tx, 'WSOL account closure without swap payout does not prove proceeds');
  }
  {
    const tx = wrappedSale();
    tx.transaction.message.instructions.push({
      programId: new PublicKey(SYSTEM),
      program: 'system',
      parsed: {
        type: 'transfer',
        info: { source: outsider, destination: owner, lamports: 10_000 },
      },
    });
    tx.meta!.postBalances[0]! += 10_000;
    await rejects(tx, 'even small independent native funding beside a valid swap is rejected');
  }
  {
    const tx = wrappedSale();
    tx.transaction.message.instructions[1] = tokenIx('closeAccount', {
      account: output,
      destination: outsider,
      owner,
    });
    await rejects(tx, 'wrapped output must actually be redeemed to the proceeds wallet');
  }
  {
    const tx = sale();
    tx.transaction.message.instructions.push(
      tokenIx('closeAccount', { account: input, destination: owner, owner }),
    );
    tx.meta!.postBalances[1] = 0;
    tx.meta!.postBalances[0] = 1e9 + RENT - FEE;
    await rejects(tx, 'rent refunds alone cannot masquerade as sale return');
  }
  {
    const tx = sale();
    tx.transaction.message.instructions = [
      { programId: key(25), accounts: [key(10), key(11)], data: '1' },
    ];
    tx.meta!.innerInstructions![0]!.instructions.unshift(swapIx());
    await rejects(tx, 'an unfamiliar wrapper around a swap remains bounded and incomplete');
  }
  {
    const tx = sale();
    tx.transaction.message.instructions = [
      { programId: key(25), accounts: [key(10), key(11)], data: '1' },
    ];
    tx.meta!.postBalances[0] = 1e9 - FEE;
    await rejects(
      tx,
      'an unknown route returning a non-native asset cannot claim complete SOL accounting',
    );
  }
  {
    const tx = sale();
    tx.transaction.message.instructions = [inputTransfer()];
    tx.meta!.innerInstructions = [];
    tx.meta!.postBalances[0] = 1e9 - FEE;
    const result = await scan(tx);
    assert.equal(result.complete, true);
    assert.equal(result.found.size, 0);
    check('a plain token transfer with only transaction fees remains a known non-sale');
  }
  {
    const tx = sale();
    tx.meta!.preTokenBalances![0]!.uiTokenAmount.amount = '90071992547409931';
    tx.meta!.postTokenBalances![0]!.uiTokenAmount.amount = '90071992547409930';
    tx.meta!.innerInstructions![0]!.instructions = [inputTransfer('1')];
    const result = await scan(tx);
    assert.equal(result.complete, true);
    closeTo(result.found.get(mint)!, NET);
    check('exact raw units preserve a debit hidden by floating-point display rounding');
  }
  {
    const parsedNames: string[] = [];
    const result = await proceedsByMint(
      owner,
      9_000_000,
      undefined,
      service([[signature('recent'), signature('old', 8000)]], () => sale(), parsedNames),
    );
    assert.deepEqual(parsedNames, ['recent']);
    assert.equal(result.complete, true);
    assert.equal(result.scanned, 1);
    closeTo(result.found.get(mint)!, NET);
    check('a page crossing the history boundary excludes older signatures before parsing');
  }
  {
    const tx = sale();
    tx.blockTime = 8000;
    const result = await scan(tx);
    assert.equal(result.complete, true);
    assert.equal(result.scanned, 0);
    assert.equal(result.found.size, 0);
    check('the parsed transaction timestamp enforces the boundary independently');
  }
  {
    const tx = sale();
    tx.blockTime = null;
    const result = await proceedsByMint(
      owner,
      9_000_000,
      undefined,
      service([[signature('unknown', null)]], () => tx),
    );
    assert.equal(result.complete, false);
    assert.equal(result.scanned, 0);
    assert.equal(result.found.size, 0);
    check('an unknown timestamp cannot pull earlier sales into the current ledger');
  }
  {
    const tx = sale();
    tx.blockTime = 9000;
    const result = await proceedsByMint(
      owner,
      9_000_000,
      undefined,
      service([[signature('exact', null)]], () => tx),
    );
    assert.equal(result.complete, true);
    closeTo(result.found.get(mint)!, NET);
    check('a parsed timestamp at the exact history boundary is included');
  }
  {
    const result = await proceedsByMint(
      owner,
      9_000_000,
      undefined,
      service([[signature('repeat'), signature('repeat')]], () => sale()),
    );
    assert.equal(result.complete, false);
    assert.equal(result.scanned, 1);
    closeTo(result.found.get(mint)!, NET);
    check('duplicate RPC signatures cannot count the same proceeds twice');
  }
  {
    const services = service([], () => sale());
    services.rpc = () => ({
      getSignaturesForAddress: async () => {
        throw new Error('offline unavailable');
      },
      getParsedTransactions: async () => [],
    });
    await assert.rejects(
      proceedsByMint(owner, 9_000_000, undefined, services),
      /offline unavailable/,
    );
    check('a first-page RPC failure remains an explicit failure');
  }
  const prepareLedger = () => {
    db.wipe();
    db.addWallet({
      id: 'offline-wallet',
      kind: 'solana',
      address: owner,
      label: 'Offline wallet',
      secret: '',
      groups: [],
      isMain: false,
      disabled: false,
      createdAt: 1,
    });
    db.recordBuy(mint, { solSpent: 0.2, fills: 1, tokensBought: 100, decimals: 6 });
    const tx = sale();
    tx.blockTime = Math.floor(Date.now() / 1000);
    return { tx, services: service([[signature('history', tx.blockTime)]], () => tx) };
  };
  {
    const { tx, services } = prepareLedger();
    let resets = 0;
    services.rpc = () => ({
      getSignaturesForAddress: async () => [signature('history', tx.blockTime!)],
      getParsedTransactions: async () => {
        await withExecutionMaintenance(async () => {
          db.wipe();
          db.recordBuy(mint, { solSpent: 0.05, fills: 1, tokensBought: 50, decimals: 6 });
          resets++;
        });
        return [tx];
      },
    });
    await assert.rejects(rebuildRealised(undefined, services), /account changed/);
    assert.equal(resets, 1);
    assert.equal(db.position(mint)!.realisedSol, 0);
    check('reset during an unlocked history read cancels application to a recreated ledger');
  }
  {
    const { tx, services } = prepareLedger();
    services.rpc = () => ({
      getSignaturesForAddress: async () => [signature('history', tx.blockTime!)],
      getParsedTransactions: async () => {
        await withExecution(async () => {
          db.recordSell(mint, 0.3, 1, 50);
        });
        return [tx];
      },
    });
    const result = await rebuildRealised(undefined, services);
    assert.equal(result.complete, true);
    assert.equal(result.repaired.length, 0);
    assert.equal(db.position(mint)!.realisedSol, 0.3);
    check('a concurrent sale already in the ledger cannot be overwritten by an older scan');
  }
  {
    const { tx, services } = prepareLedger();
    const startedAt = db.position(mint)!.firstBuyAt;
    services.rpc = () => ({
      getSignaturesForAddress: async () => [signature('history', tx.blockTime!)],
      getParsedTransactions: async () => {
        await withExecution(async () => {
          db.position(mint)!.firstBuyAt = startedAt + 1000;
        });
        return [tx];
      },
    });
    const result = await rebuildRealised(undefined, services);
    assert.equal(result.repaired.length, 0);
    assert.equal(db.position(mint)!.realisedSol, 0);
    check('a changed position identity cannot inherit proceeds from the scan-start record');
  }
  console.log(`\n${passed} offline deep reconciliation regressions passed.`);
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
