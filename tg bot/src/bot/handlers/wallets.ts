import type { Context } from 'grammy';
import { InlineKeyboard, InputFile } from 'grammy';
import { db } from '../../store/db.js';
import {
  allWallets,
  walletById,
  generateSolanaWallet,
  generateEvmWallet,
  importPrivateKey,
  deriveWallets,
  getOrCreateMnemonic,
  setMnemonic,
  renameWallet,
  setMain,
  toggleDisabled,
  addToGroup,
  removeWallet,
  exportSecret,
  groups as allGroups,
} from '../../store/wallets.js';
import { getSolBalance } from '../../chains/solana.js';
import { errMessage, fmtAmount, shortAddr } from '../../util.js';
import { setPending, shortWalletId, walletFromShortId, stageConfirmation } from '../session.js';
import {
  renderWalletList,
  walletsKeyboard,
  walletManageKeyboard,
  walletDetailKeyboard,
  confirmKeyboard,
  backButton,
  h,
} from '../ui.js';
import { render } from './core.js';

export async function showWallets(ctx: Context): Promise<void> {
  const wallets = allWallets();
  await render(ctx, renderWalletList(wallets, db.settings().activeGroup), walletsKeyboard(wallets));
}

export async function showWalletManage(ctx: Context): Promise<void> {
  const wallets = allWallets();
  if (wallets.length === 0) {
    await render(ctx, '<b>👛 No wallets yet.</b>', backButton('wallets'));
    return;
  }
  await render(ctx, '<b>🏷 Pick a wallet to manage</b>', walletManageKeyboard(wallets));
}

export async function showWalletDetail(ctx: Context, walletId: string): Promise<void> {
  const w = walletById(walletId);
  if (!w) {
    await render(ctx, '<i>That wallet no longer exists.</i>', backButton('wallets'));
    return;
  }

  const lines = [
    `<b>${h(w.label)}</b>`,
    `<code>${h(w.address)}</code>`,
    '',
    `Chain: ${w.kind === 'solana' ? 'Solana' : 'EVM'}`,
    `Main: ${w.isMain ? '★ yes' : 'no'}`,
    `Status: ${w.disabled ? '⏸ excluded from batches' : '▶️ active'}`,
    `Groups: ${w.groups.length > 0 ? h(w.groups.join(', ')) : '<i>none</i>'}`,
  ];

  if (w.derivationIndex !== undefined) lines.push(`HD index: ${w.derivationIndex}`);

  if (w.kind === 'solana') {
    try {
      const { sol } = await getSolBalance(w.address);
      lines.push('', `Balance: <b>${fmtAmount(sol, 6)} SOL</b>`);
    } catch {
      /* balance is decoration here */
    }
  }

  await render(ctx, lines.join('\n'), walletDetailKeyboard(w));
}

// ── creation ──────────────────────────────────────────────────────────────────

export async function generateWallet(ctx: Context, kind: 'solana' | 'evm'): Promise<void> {
  try {
    const w = kind === 'solana' ? generateSolanaWallet() : generateEvmWallet();
    await ctx.answerCallbackQuery({ text: `Created ${w.label}` });
    await showWallets(ctx);
  } catch (err) {
    await ctx.answerCallbackQuery({ text: errMessage(err), show_alert: true });
  }
}

export async function promptImportKey(ctx: Context): Promise<void> {
  setPending(ctx.from!.id, { kind: 'import_key' });
  await render(
    ctx,
    [
      '<b>📥 Import a private key</b>',
      '',
      'Send one key per message. Both formats work:',
      '· Solana — base58, the string Phantom exports',
      '· EVM — 0x followed by 64 hex characters',
      '',
      '<i>Your message is deleted the moment I read it. The key is encrypted before it touches disk.</i>',
    ].join('\n'),
    backButton('wallets'),
  );
}

export async function handleImportKey(ctx: Context, text: string): Promise<void> {
  try {
    const w = importPrivateKey(text);
    await ctx.reply(
      `✅ Imported <b>${h(w.label)}</b>\n<code>${h(w.address)}</code>`,
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('👛 Wallets', 'wallets') },
    );
  } catch (err) {
    await ctx.reply(`❌ ${errMessage(err)}`);
  }
}

export async function promptDerive(ctx: Context): Promise<void> {
  const kb = new InlineKeyboard()
    .text('Solana ×5', 'derive:solana:5').text('Solana ×10', 'derive:solana:10')
    .row()
    .text('Solana ×25', 'derive:solana:25').text('Solana ×50', 'derive:solana:50')
    .row()
    .text('EVM ×5', 'derive:evm:5').text('EVM ×10', 'derive:evm:10')
    .row()
    .text('🔑 Show seed phrase', 'show_mnemonic').text('📥 Import seed', 'import_mnemonic')
    .row()
    .text('← Back', 'wallets');

  await render(
    ctx,
    [
      '<b>🌱 Derive an HD wallet set</b>',
      '',
      'All derived wallets come from one seed phrase, so a single backup restores every wallet.',
      '',
      'Solana uses <code>m/44\'/501\'/i\'/0\'</code>, EVM uses <code>m/44\'/60\'/0\'/0/i</code> — the same paths Phantom and MetaMask use, so the wallets import cleanly elsewhere.',
    ].join('\n'),
    kb,
  );
}

export async function executeDerive(ctx: Context, kind: 'solana' | 'evm', count: number): Promise<void> {
  await render(ctx, `<b>🌱 Deriving ${count} ${kind} wallets…</b>`);

  try {
    const created = deriveWallets(kind, count);
    const lines = [`<b>✅ Derived ${created.length} wallets</b>`, ''];
    for (const w of created.slice(0, 20)) {
      lines.push(`· <b>${h(w.label)}</b> <code>${shortAddr(w.address, 6, 6)}</code>`);
    }
    if (created.length > 20) lines.push(`<i>…and ${created.length - 20} more</i>`);

    await render(ctx, lines.join('\n'), new InlineKeyboard().text('👛 Wallets', 'wallets'));
  } catch (err) {
    await render(ctx, `❌ ${h(errMessage(err))}`, backButton('wallets'));
  }
}

export async function showMnemonic(ctx: Context): Promise<void> {
  try {
    const phrase = getOrCreateMnemonic();
    const sent = await ctx.reply(
      [
        '<b>🔑 Seed phrase</b>',
        '',
        `<code>${h(phrase)}</code>`,
        '',
        '<i>Write this down offline. This message self-destructs in 60 seconds.</i>',
      ].join('\n'),
      { parse_mode: 'HTML' },
    );

    scheduleDelete(ctx, sent.chat.id, sent.message_id, 60_000);
    await ctx.answerCallbackQuery({ text: 'Sent — deleting in 60s' });
  } catch (err) {
    await ctx.answerCallbackQuery({ text: errMessage(err), show_alert: true });
  }
}

export async function promptImportMnemonic(ctx: Context): Promise<void> {
  setPending(ctx.from!.id, { kind: 'import_mnemonic' });
  await render(
    ctx,
    [
      '<b>📥 Import a seed phrase</b>',
      '',
      'Send your 12 or 24 word BIP-39 phrase.',
      '',
      '<i>Message deleted on receipt. Replaces the current seed — wallets already derived from the old one keep working, since their keys are stored individually.</i>',
    ].join('\n'),
    backButton('wallets'),
  );
}

export async function handleImportMnemonic(ctx: Context, text: string): Promise<void> {
  try {
    setMnemonic(text);
    await ctx.reply('✅ Seed phrase stored and encrypted.', {
      reply_markup: new InlineKeyboard().text('🌱 Derive wallets', 'derive_menu'),
    });
  } catch (err) {
    await ctx.reply(`❌ ${errMessage(err)}`);
  }
}

// ── mutation ──────────────────────────────────────────────────────────────────

export async function doSetMain(ctx: Context, walletId: string): Promise<void> {
  try {
    const w = setMain(walletId);
    await ctx.answerCallbackQuery({ text: `★ ${w.label} is now the main wallet` });
    await showWalletDetail(ctx, walletId);
  } catch (err) {
    await ctx.answerCallbackQuery({ text: errMessage(err), show_alert: true });
  }
}

export async function doToggle(ctx: Context, walletId: string): Promise<void> {
  try {
    const w = toggleDisabled(walletId);
    await ctx.answerCallbackQuery({ text: w.disabled ? 'Excluded from batches' : 'Active again' });
    await showWalletDetail(ctx, walletId);
  } catch (err) {
    await ctx.answerCallbackQuery({ text: errMessage(err), show_alert: true });
  }
}

export async function promptRename(ctx: Context, walletId: string): Promise<void> {
  setPending(ctx.from!.id, { kind: 'rename_wallet', walletId });
  await render(ctx, '<b>🏷 Send the new label.</b>', backButton('wallet_manage'));
}

export async function promptGroup(ctx: Context, walletId: string): Promise<void> {
  setPending(ctx.from!.id, { kind: 'group_wallet', walletId });
  const existing = allGroups();
  await render(
    ctx,
    [
      '<b>🏷 Send a group name for this wallet.</b>',
      existing.length > 0 ? `\nExisting groups: <i>${h(existing.join(', '))}</i>` : '',
    ].join('\n'),
    backButton('wallet_manage'),
  );
}

export async function handleRename(ctx: Context, walletId: string, label: string): Promise<void> {
  try {
    const w = renameWallet(walletId, label);
    await ctx.reply(`✅ Renamed to <b>${h(w.label)}</b>`, { parse_mode: 'HTML' });
  } catch (err) {
    await ctx.reply(`❌ ${errMessage(err)}`);
  }
}

export async function handleGroup(ctx: Context, walletId: string, group: string): Promise<void> {
  try {
    const w = addToGroup(walletId, group);
    await ctx.reply(`✅ <b>${h(w.label)}</b> is now in: ${h(w.groups.join(', '))}`, { parse_mode: 'HTML' });
  } catch (err) {
    await ctx.reply(`❌ ${errMessage(err)}`);
  }
}

export async function promptRemove(ctx: Context, walletId: string): Promise<void> {
  const w = walletById(walletId);
  if (!w) return;

  const id = stageConfirmation(ctx.from!.id, `remove ${w.label}`, async (confirmCtx) => {
    removeWallet(walletId);
    await render(confirmCtx, `🗑 Removed <b>${h(w.label)}</b>.`, new InlineKeyboard().text('👛 Wallets', 'wallets'));
  });

  await render(
    ctx,
    [
      `<b>🗑 Remove ${h(w.label)}?</b>`,
      `<code>${h(w.address)}</code>`,
      '',
      '<b>This deletes the encrypted key from the vault.</b> Export it first if the wallet still holds funds — there is no recovery.',
    ].join('\n'),
    confirmKeyboard(id, 'wallet_manage'),
  );
}

export async function doExportKey(ctx: Context, walletId: string): Promise<void> {
  const w = walletById(walletId);
  if (!w) return;

  try {
    const secret = exportSecret(w);
    const sent = await ctx.reply(
      [
        `<b>🔑 ${h(w.label)}</b>`,
        `<code>${h(w.address)}</code>`,
        '',
        `<code>${h(secret)}</code>`,
        '',
        '<i>Self-destructs in 60 seconds. Anyone with this string owns the wallet.</i>',
      ].join('\n'),
      { parse_mode: 'HTML' },
    );

    scheduleDelete(ctx, sent.chat.id, sent.message_id, 60_000);
    await ctx.answerCallbackQuery({ text: 'Key sent — deleting in 60s' });
  } catch (err) {
    await ctx.answerCallbackQuery({ text: errMessage(err), show_alert: true });
  }
}

export async function exportAddresses(ctx: Context): Promise<void> {
  const wallets = allWallets();
  if (wallets.length === 0) {
    await ctx.answerCallbackQuery({ text: 'No wallets yet.', show_alert: true });
    return;
  }

  const body = wallets.map((w) => `${w.label}\t${w.address}\t${w.kind}\t${w.groups.join('|')}`).join('\n');
  const file = Buffer.from(`label\taddress\tchain\tgroups\n${body}\n`, 'utf8');

  await ctx.replyWithDocument(new InputFile(file, 'wallet-addresses.tsv'), {
    caption: `${wallets.length} wallet addresses. Public data only — no keys.`,
  });
  await ctx.answerCallbackQuery();
}

// ── group filter ──────────────────────────────────────────────────────────────

export async function showGroupFilter(ctx: Context): Promise<void> {
  const gs = allGroups();
  const active = db.settings().activeGroup;

  const kb = new InlineKeyboard().text(active === null ? '● All wallets' : '○ All wallets', 'setgroup:__all__').row();
  for (const g of gs) {
    kb.text(`${active === g ? '●' : '○'} ${g}`, `setgroup:${g}`).row();
  }
  kb.text('← Back', 'wallets');

  await render(
    ctx,
    [
      '<b>🎯 Batch target</b>',
      '',
      'Every buy, sell and sweep applies to the wallets in the selected group.',
      gs.length === 0 ? '\n<i>No groups yet. Tag wallets from Wallets → Manage.</i>' : '',
    ].join('\n'),
    kb,
  );
}

export async function setGroupFilter(ctx: Context, group: string): Promise<void> {
  db.updateSettings({ activeGroup: group === '__all__' ? null : group });
  await ctx.answerCallbackQuery({ text: group === '__all__' ? 'Targeting all wallets' : `Targeting ${group}` });
  await showGroupFilter(ctx);
}

// ── helpers ───────────────────────────────────────────────────────────────────

function scheduleDelete(ctx: Context, chatId: number, messageId: number, delayMs: number): void {
  const timer = setTimeout(() => {
    ctx.api.deleteMessage(chatId, messageId).catch(() => {
      /* already gone, or too old to delete */
    });
  }, delayMs);
  timer.unref?.();
}

export { shortWalletId, walletFromShortId };
