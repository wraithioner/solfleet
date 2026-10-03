/** Offline public-behavior regressions. No source-code matching or live services. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Keypair, PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import type { AutoRule } from '../../src/store/db.js';

import {
  dataDir,
  db,
  vault,
  wallets,
  BASE_FEE_LAMPORTS,
  armCopyRules,
  handlers,
  batchSweepSol,
  exitReserveLamports,
  client,
  check,
  target,
  context,
  mockToken,
} from './fixtures.js';

export async function runStorageBehaviors(): Promise<void> {
  // Exercise the actual durable-write API with observed filesystem calls.
  {
    const file = path.join(dataDir, 'atomic-fixture');
    const order: string[] = [];
    const sync = fs.fsyncSync;
    const rename = fs.renameSync;
    fs.fsyncSync = fd => {
      order.push('sync');
      sync(fd);
    };
    fs.renameSync = (from, to) => {
      order.push('rename');
      rename(from, to);
    };
    try {
      vault.writeAtomic(file, 'first');
      vault.writeAtomic(file, 'latest');
    } finally {
      fs.fsyncSync = sync;
      fs.renameSync = rename;
    }
    assert.ok(order.indexOf('sync') < order.indexOf('rename'));
    assert.equal(fs.readFileSync(file, 'utf8'), 'latest');
    assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), 'latest');
    fs.renameSync = () => {
      throw new Error('injected rename failure');
    };
    try {
      assert.throws(() => vault.writeAtomic(file, 'failed'), /injected rename/);
    } finally {
      fs.renameSync = rename;
    }
    assert.equal(fs.readFileSync(file, 'utf8'), 'latest');
    assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), 'latest');
    assert.equal(fs.existsSync(`${file}.${process.pid}.tmp`), false);
    check(
      'atomic writes sync before replacement, keep the current backup and clean up failed replacements',
    );
  }
  {
    db.wipe();
    const half = target({ takeProfitPct: 20, takeProfitSellPct: 50 });
    const custom = target({ takeProfitPct: 20, takeProfitSellPct: 75 });
    const rule = (id: string, patch: Partial<AutoRule> = {}): AutoRule => ({
      id,
      mint: id,
      kind: 'take_profit',
      triggerPct: 20,
      sellPercent: 50,
      enabled: true,
      createdAt: 1,
      ...patch,
    });
    db.addRule(rule('legacy-half'));
    db.addRule(rule('already-fired', { firedAt: 1 }));
    db.addRule(rule('custom-exit', { sellPercent: 75 }));
    db.reload();
    assert.equal(db.copyTargets().find(t => t.id === half.id)?.takeProfitSellPct, 100);
    assert.equal(db.copyTargets().find(t => t.id === custom.id)?.takeProfitSellPct, 75);
    assert.equal(db.raw().rules.find(r => r.id === 'legacy-half')?.sellPercent, 100);
    assert.equal(db.raw().rules.find(r => r.id === 'already-fired')?.sellPercent, 50);
    assert.equal(db.raw().rules.find(r => r.id === 'custom-exit')?.sellPercent, 75);
    const defaults = target({ takeProfitPct: 20 });
    armCopyRules(defaults, 'new-default');
    assert.equal(db.rulesFor('new-default')[0]?.sellPercent, 100);
    const mint = Keypair.generate().publicKey.toBase58();
    mockToken(mint);
    db.recordBuy(mint, {
      solSpent: 0.05,
      fills: 1,
      tokensBought: 100,
      costSol: 0.05,
      freshEntry: true,
      decimals: 0,
    });
    await handlers.addAutoRule(context().ctx, mint, 'take_profit', 20);
    assert.equal(db.rulesFor(mint)[0]?.sellPercent, 100);
    check(
      'loaded half-exit defaults migrate while custom/fired exits survive and new rules exit completely',
    );
  }

  {
    db.wipe();
    const sender = wallets.generateSolanaWallet('sweep-fixture');
    const destination = Keypair.generate().publicKey.toBase58();
    const balance = 1_000_000_000n;
    db.updateSettings({
      priorityFeeSol: 0.00005,
      sweepReserveSol: 0.002,
      executionMode: 'parallel',
    });
    client.getBalance = async () => Number(balance);
    client.getLatestBlockhash = async () => ({
      blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: 1,
    });
    client.getSignatureStatuses = async () => ({
      context: { slot: 1 },
      value: [
        {
          slot: 1,
          confirmations: 1,
          err: null,
          confirmationStatus: 'confirmed',
        },
      ],
    });
    let sent = 0n;
    client.sendRawTransaction = async bytes => {
      const tx = VersionedTransaction.deserialize(Uint8Array.from(bytes));
      const transfer = tx.message.compiledInstructions.find(ix =>
        tx.message.staticAccountKeys[ix.programIdIndex]?.equals(SystemProgram.programId),
      );
      assert.ok(transfer);
      sent = Buffer.from(transfer.data).readBigUInt64LE(4);
      return 'offline';
    };
    client.getParsedTokenAccountsByOwner = async () => ({ context: { slot: 1 }, value: [] });
    await batchSweepSol([sender], destination);
    const emptyRemainder = balance - sent - BigInt(BASE_FEE_LAMPORTS) - 50_000n;
    assert.equal(emptyRemainder, 2_000_000n);
    client.getParsedTokenAccountsByOwner = async () => {
      throw new Error('unreadable holdings');
    };
    await batchSweepSol([sender], destination);
    const unknownRemainder = balance - sent - BigInt(BASE_FEE_LAMPORTS) - 50_000n;
    assert.ok(unknownRemainder >= exitReserveLamports(0.0002, 0, { holdsTokens: true }));
    assert.ok(unknownRemainder > emptyRemainder);
    check(
      'sweeps honor the configured reserve and keep the token exit floor when holdings are unknown',
    );
  }
}
