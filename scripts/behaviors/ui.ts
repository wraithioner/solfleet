/** Offline public-behavior regressions. No source-code matching or live services. */
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import type { InlineKeyboard } from 'grammy';
import type { Update } from 'grammy/types';

import {
  db,
  wallets,
  createBot,
  session,
  handlers,
  ui,
  rebuildPnl,
  client,
  originalNow,
  check,
  context,
  mockToken,
} from './fixtures.js';

export async function runUiBehaviors(): Promise<void> {
  // Real Telegram middleware/router, with only the transport replaced.
  {
    db.wipe();
    const bot = createBot();
    bot.botInfo = {
      id: 123,
      is_bot: true,
      first_name: 'Offline',
      username: 'offline_bot',
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
    } as typeof bot.botInfo;
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    bot.api.config.use(async (_previous, method, payload) => {
      const request = payload as Record<string, unknown>;
      calls.push({ method, payload: request });
      const result =
        method === 'sendMessage' || method === 'editMessageText'
          ? {
              message_id: 10,
              date: 0,
              chat: { id: request.chat_id, type: 'private' },
              text: request.text,
            }
          : true;
      return { ok: true, result } as never;
    });
    let updateId = 0;
    const callback = (data: string): Update => ({
      update_id: ++updateId,
      callback_query: {
        id: `q-${updateId}`,
        chat_instance: 'offline',
        data,
        from: { id: 1, is_bot: false, first_name: 'Owner' },
        message: { message_id: 11, date: 0, chat: { id: 1, type: 'private', first_name: 'Owner' } },
      },
    });
    const callbackData = (keyboard: InlineKeyboard) =>
      keyboard.inline_keyboard
        .flat()
        .flatMap(button => ('callback_data' in button ? [button.callback_data] : []));
    const keyboards = [
      ui.mainMenu(),
      ui.portfolioKeyboard(),
      ui.pnlKeyboard(),
      ui.settingsKeyboard(db.settings()),
      ui.copyDecisionsKeyboard(),
    ];
    for (const data of new Set(keyboards.flatMap(callbackData))) {
      calls.length = 0;
      await bot.handleUpdate(callback(data));
      assert.ok(
        !calls.some(call => call.payload.text === 'Unknown action.'),
        `${data} must reach a route`,
      );
      assert.ok(calls.length > 0, `${data} must respond`);
    }
    check(
      'public navigation keyboards reach actual callback handlers through the authenticated bot',
    );
    session.setPending(1, { kind: 'custom_buy', mint: 'old-mint' });
    await bot.handleUpdate(callback('copy_add'));
    assert.equal(session.takePending(1)?.kind, 'copy_address');
    session.setPending(1, { kind: 'custom_buy', mint: 'old-mint' });
    await bot.handleUpdate(callback('home'));
    assert.equal(session.takePending(1), undefined);
    check('callback navigation clears stale prompts before installing a new prompt');
    const mint = Keypair.generate().publicKey.toBase58();
    mockToken(mint);
    session.setPending(1, { kind: 'custom_buy', mint: 'old-mint' });
    calls.length = 0;
    await bot.handleUpdate({
      update_id: ++updateId,
      message: {
        message_id: updateId,
        date: 0,
        from: { id: 1, is_bot: false, first_name: 'Owner' },
        chat: { id: 1, type: 'private', first_name: 'Owner' },
        text: mint,
      },
    });
    assert.equal(session.session(1).lastTokenMint, mint);
    assert.ok(calls.some(call => String(call.payload.text).includes('Fixture')));
    assert.equal(session.takePending(1), undefined);
    session.setPending(1, { kind: 'copy_address' });
    Date.now = () => originalNow() + 6 * 60_000;
    try {
      assert.equal(session.takePending(1), undefined);
    } finally {
      Date.now = originalNow;
    }
    check('mint pastes override numeric prompts and abandoned prompts expire');
    db.recordCopyDecision({
      at: Date.now(),
      target: '<target>',
      mint: '<mint>',
      reason: '<reason>',
    });
    const rendered = ui.renderCopyDecisions(db.copyDecisions());
    assert.ok(rendered.includes('<code>&lt;mint&gt;</code>'));
    const copyScreen = context();
    await handlers.showCopyTrade(copyScreen.ctx);
    assert.ok(
      copyScreen.keyboards.some(keyboard =>
        keyboard.inline_keyboard
          .flat()
          .some(
            button =>
              'callback_data' in button &&
              button.callback_data === 'copy_decisions' &&
              button.text.includes('(1)'),
          ),
      ),
    );
    const safetyScreen = context();
    await handlers.showCopySafety(safetyScreen.ctx);
    assert.ok(
      safetyScreen.keyboards.every(keyboard => !callbackData(keyboard).includes('safety_lock')),
    );
    assert.ok(safetyScreen.text.every(text => !text.includes('Ignore supply locked')));
    calls.length = 0;
    await bot.handleUpdate(callback('safety_lock'));
    assert.ok(!calls.some(call => call.payload.text === 'Unknown action.'));
    check(
      'skip history stays reachable with full escaped mints and obsolete lock controls remain compatible',
    );
  }
  {
    db.wipe();
    wallets.generateSolanaWallet('reconciliation-fixture');
    client.getSignaturesForAddress = async () => [
      {
        signature: 'unreadable',
        slot: 1,
        err: null,
        memo: null,
        blockTime: Math.floor(Date.now() / 1000),
        confirmationStatus: 'confirmed',
      },
    ];
    client.getParsedTransactions = async () => [null];
    const incomplete = context();
    await rebuildPnl(incomplete.ctx);
    assert.ok(
      incomplete.text.some(text => /Only part of the history|Nothing could be read/.test(text)),
    );
    assert.ok(incomplete.text.every(text => !text.includes('Nothing was missing')));
    client.getSignaturesForAddress = async () => [];
    const complete = context();
    await rebuildPnl(complete.ctx);
    assert.ok(complete.text.some(text => text.includes('Nothing was missing')));
    check(
      'reconciliation UI reports incomplete reads and reserves the all-clear for a complete scan',
    );
  }
}
