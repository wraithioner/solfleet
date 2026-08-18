import { Bot, InlineKeyboard, type Context } from 'grammy';
import { config } from '../config.js';
import { log } from '../logger.js';
import { db } from '../store/db.js';
import {
  isUnlocked,
  vaultExists,
  initVault,
  unlockVault,
  lockVault,
  changePassphrase,
} from '../store/vault.js';
import { resealAll, allWallets } from '../store/wallets.js';
import { errMessage } from '../util.js';
import { extractTokenAddress } from '../services/tokeninfo.js';
import {
  session,
  setPending,
  takePending,
  takeConfirmation,
  mintFromId,
  walletFromShortId,
} from './session.js';
import { mainMenu, backButton, h } from './ui.js';
import {
  render,
  showHome,
  showPortfolio,
  showPositions,
  showSettings,
  showFactoryReset,
  executeFactoryReset,
} from './handlers/core.js';
import * as W from './handlers/wallets.js';
import * as T from './handlers/trade.js';

export function createBot(): Bot {
  const bot = new Bot(config.botToken);

  // ── auth: everything not from the owner is dropped silently ────────────────
  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (!id || !config.ownerIds.includes(id)) {
      if (id) log.warn(`Ignored update from unauthorised user ${id}`);
      return; // no reply — an unauthorised caller learns nothing, not even that the bot is alive
    }
    await next();
  });

  registerCommands(bot);
  registerCallbacks(bot);
  registerText(bot);

  bot.catch((err) => {
    log.error('Unhandled bot error', err.error);
  });

  return bot;
}

// ── commands ──────────────────────────────────────────────────────────────────

function registerCommands(bot: Bot): void {
  bot.command('start', async (ctx) => {
    await showHome(ctx);
  });

  bot.command('menu', async (ctx) => {
    await showHome(ctx);
  });

  bot.command('unlock', async (ctx) => {
    const passphrase = ctx.match?.toString().trim();

    // the passphrase is now in the chat log — remove it before doing anything else
    await deleteMessage(ctx);

    if (!passphrase) {
      await ctx.reply('Usage: /unlock <passphrase>');
      return;
    }

    if (!vaultExists()) {
      try {
        await initVault(passphrase);
        await ctx.reply('🔐 Vault created and unlocked.', { reply_markup: mainMenu() });
      } catch (err) {
        await ctx.reply(`❌ ${errMessage(err)}`);
      }
      return;
    }

    try {
      await unlockVault(passphrase);
      await ctx.reply('🔓 Vault unlocked.', { reply_markup: mainMenu() });
    } catch (err) {
      await ctx.reply(`❌ ${errMessage(err)}`);
    }
  });

  bot.command('lock', async (ctx) => {
    lockVault();
    await ctx.reply('🔒 Vault locked. Keys are out of memory.');
  });

  bot.command('portfolio', async (ctx) => {
    if (!(await requireUnlocked(ctx))) return;
    await showPortfolio(ctx);
  });

  bot.command('wallets', async (ctx) => {
    if (!(await requireUnlocked(ctx))) return;
    await W.showWallets(ctx);
  });

  bot.command('history', async (ctx) => {
    const entries = db.tradeLog(15);
    if (entries.length === 0) {
      await ctx.reply('No batch operations recorded yet.');
      return;
    }

    const lines = ['<b>📜 Recent batch operations</b>', ''];
    for (const e of entries) {
      const when = new Date(e.at).toISOString().replace('T', ' ').slice(5, 16);
      lines.push(
        `<code>${when}</code> ${h(e.action)} — ✅ ${e.succeeded} ❌ ${e.failed}` +
          (e.mint ? `\n   <code>${h(e.mint.slice(0, 20))}…</code>` : ''),
      );
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      [
        '<b>Commands</b>',
        '',
        '/start — main menu',
        '/unlock &lt;passphrase&gt; — unlock the vault',
        '/lock — wipe keys from memory',
        '/portfolio — balances across every wallet',
        '/wallets — manage wallets',
        '/history — recent batch operations',
        '',
        '<b>Paste any token address</b> to get its stats, holder breakdown and trade buttons.',
        '',
        'Wallets need SOL before they can buy: <b>Move Funds → Fund wallets from main</b>.',
      ].join('\n'),
      { parse_mode: 'HTML' },
    );
  });
}

// ── callback queries ──────────────────────────────────────────────────────────

function registerCallbacks(bot: Bot): void {
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const [action, ...args] = data.split(':');

    // Every screen except the vault prompts needs an unlocked vault. Factory
    // reset is the exception: a forgotten passphrase is the likeliest reason to
    // need it, and it destroys the keys rather than using them.
    if (!isUnlocked() && action !== 'home' && action !== 'factory_reset') {
      await ctx.answerCallbackQuery({ text: '🔒 Vault is locked. Send /unlock <passphrase>.', show_alert: true });
      return;
    }

    try {
      await routeCallback(ctx, action ?? '', args);
    } catch (err) {
      log.error(`Callback "${data}" failed`, err);
      await ctx.answerCallbackQuery({ text: errMessage(err).slice(0, 190), show_alert: true }).catch(() => {});
    }

    // grammY throws if a query is answered twice; ignoring that is fine
    await ctx.answerCallbackQuery().catch(() => {});
  });
}

async function routeCallback(ctx: Context, action: string, args: string[]): Promise<void> {
  const userId = ctx.from!.id;

  switch (action) {
    // navigation
    case 'home':
      return showHome(ctx);
    case 'portfolio':
      return showPortfolio(ctx);
    case 'positions':
      return showPositions(ctx);
    case 'settings':
      return showSettings(ctx);
    case 'wallets':
      return W.showWallets(ctx);
    case 'trade_menu':
      return T.showTradeMenu(ctx);
    case 'copy_trade':
      return T.showCopyTrade(ctx);
    case 'copy_add':
      return T.promptCopyAdd(ctx);
    case 'copy_toggle':
      return T.toggleCopyTarget(ctx, args[0] ?? '');
    case 'copy_remove':
      return T.removeCopyTarget(ctx, args[0] ?? '');
    case 'consolidate_menu':
      return T.showConsolidateMenu(ctx);

    case 'lock': {
      lockVault();
      return render(ctx, '🔒 <b>Vault locked.</b>\n\nSend <code>/unlock &lt;passphrase&gt;</code> to continue.');
    }

    // confirmations
    case 'confirm': {
      const confirmation = takeConfirmation(userId, args[0] ?? '');
      if (!confirmation) {
        await ctx.answerCallbackQuery({ text: 'That confirmation expired. Start again.', show_alert: true });
        return;
      }
      log.info(`Confirmed action: ${confirmation.label}`);
      return confirmation.run(ctx);
    }

    // token card
    case 'tokeninfo': {
      const mint = mintFromId(args[0] ?? '');
      if (!mint) return void ctx.answerCallbackQuery({ text: 'Token reference expired.', show_alert: true });
      return T.showTokenCard(ctx, mint, true);
    }
    case 'holders': {
      const mint = mintFromId(args[0] ?? '');
      if (!mint) return void ctx.answerCallbackQuery({ text: 'Token reference expired.', show_alert: true });
      return T.showHolders(ctx, mint);
    }

    // trading
    case 'buy': {
      const mint = mintFromId(args[0] ?? '');
      const amount = Number(args[1]);
      if (!mint || !Number.isFinite(amount)) {
        return void ctx.answerCallbackQuery({ text: 'Bad buy parameters.', show_alert: true });
      }
      return T.promptBuy(ctx, mint, amount);
    }
    case 'buycustom': {
      const mint = mintFromId(args[0] ?? '');
      if (!mint) return void ctx.answerCallbackQuery({ text: 'Token reference expired.', show_alert: true });
      setPending(userId, { kind: 'custom_buy', mint });
      return render(ctx, '<b>🟢 Send the SOL amount to buy per wallet.</b>\n\n<i>e.g. 0.25</i>', backButton());
    }
    case 'sell': {
      const mint = mintFromId(args[0] ?? '');
      const pct = Number(args[1]);
      if (!mint || !Number.isFinite(pct)) {
        return void ctx.answerCallbackQuery({ text: 'Bad sell parameters.', show_alert: true });
      }
      return T.promptSell(ctx, mint, pct);
    }
    case 'autosell': {
      const mint = mintFromId(args[0] ?? '');
      if (!mint) return void ctx.answerCallbackQuery({ text: 'Token reference expired.', show_alert: true });
      return T.showAutoSell(ctx, mint);
    }
    case 'rule': {
      const [what, tokenRef, pctRaw] = [args[0] ?? '', args[1] ?? '', args[2] ?? '0'];
      const mint = mintFromId(tokenRef);
      if (!mint) return void ctx.answerCallbackQuery({ text: 'Token reference expired.', show_alert: true });
      if (what === 'clear') return T.clearAutoRules(ctx, mint);

      const kind = what === 'tp' ? 'take_profit' : what === 'sl' ? 'stop_loss' : 'trailing_stop';
      return T.addAutoRule(ctx, mint, kind, Number(pctRaw));
    }

    case 'sell_all_confirm':
      return T.promptSellEverything(ctx);

    // funding + consolidation
    case 'fund_menu':
      return T.showFundMenu(ctx);
    case 'fund':
      return T.promptFundAmount(ctx, args[0] === 'topup' ? 'topup' : 'each');
    case 'sweep_sol_confirm':
      return T.promptSweepSol(ctx);
    case 'sweep_token_prompt':
      return T.promptSweepToken(ctx);

    // wallets
    case 'gen':
      return W.generateWallet(ctx);
    case 'import_key':
      return W.promptImportKey(ctx);
    case 'derive_menu':
      return W.promptDerive(ctx);
    case 'derive':
      return W.executeDerive(ctx, Number(args[0] ?? 5));
    case 'show_mnemonic':
      return W.showMnemonic(ctx);
    case 'import_mnemonic':
      return W.promptImportMnemonic(ctx);
    case 'wallet_manage':
      return W.showWalletManage(ctx);
    case 'export_addresses':
      return W.exportAddresses(ctx);
    case 'group_filter':
      return W.showGroupFilter(ctx);
    case 'setgroup':
      return W.setGroupFilter(ctx, args[0] ?? '__all__');

    case 'wallet':
    case 'setmain':
    case 'toggle':
    case 'rename':
    case 'group':
    case 'export':
    case 'remove': {
      const walletId = walletFromShortId(args[0] ?? '');
      if (!walletId) return void ctx.answerCallbackQuery({ text: 'Wallet reference expired.', show_alert: true });

      switch (action) {
        case 'wallet':
          return W.showWalletDetail(ctx, walletId);
        case 'setmain':
          return W.doSetMain(ctx, walletId);
        case 'toggle':
          return W.doToggle(ctx, walletId);
        case 'rename':
          return W.promptRename(ctx, walletId);
        case 'group':
          return W.promptGroup(ctx, walletId);
        case 'export':
          return W.doExportKey(ctx, walletId);
        case 'remove':
          return W.promptRemove(ctx, walletId);
      }
      return;
    }

    // settings
    case 'toggle_mode': {
      const next = db.settings().executionMode === 'bundle' ? 'parallel' : 'bundle';
      db.updateSettings({ executionMode: next });
      await ctx.answerCallbackQuery({ text: `Execution mode: ${next}` });
      return showSettings(ctx);
    }
    case 'set_slippage':
      setPending(userId, { kind: 'set_slippage' });
      return render(ctx, '<b>Send the slippage percent.</b>\n\n<i>e.g. 15 — memecoins usually need 10-25.</i>', backButton('settings'));
    case 'set_priority_fee':
      setPending(userId, { kind: 'set_priority_fee' });
      return render(ctx, '<b>Send the priority fee in SOL.</b>\n\n<i>e.g. 0.0001 — raise it when the network is congested.</i>', backButton('settings'));
    case 'set_jito_tip':
      setPending(userId, { kind: 'set_jito_tip' });
      return render(ctx, '<b>Send the Jito tip in SOL.</b>\n\n<i>Only used in bundle mode. e.g. 0.0001</i>', backButton('settings'));
    case 'set_reserve':
      setPending(userId, { kind: 'set_reserve' });
      return render(ctx, '<b>Send the SOL to leave in each wallet when sweeping.</b>\n\n<i>e.g. 0.002</i>', backButton('settings'));

    case 'toggle_fee_mode': {
      const next = db.settings().priorityFeeMode === 'auto' ? 'fixed' : 'auto';
      db.updateSettings({ priorityFeeMode: next });
      await ctx.answerCallbackQuery({
        text:
          next === 'auto'
            ? 'Priority fee follows the network, up to your ceiling'
            : 'Priority fee stays exactly where you set it',
      });
      return showSettings(ctx);
    }

    case 'set_fee_ceiling':
      setPending(userId, { kind: 'set_fee_ceiling' });
      return render(
        ctx,
        [
          '<b>Send the most SOL a single trade may pay in priority fees.</b>',
          '',
          `Current: <b>${db.settings().priorityFeeCeilingSol} SOL</b>`,
          '',
          '<i>Auto mode never bids above this, however busy the chain gets. 0.005 is a sane cap.</i>',
        ].join('\n'),
        backButton('settings'),
      );

    case 'set_buy_presets':
      setPending(userId, { kind: 'set_buy_presets' });
      return render(
        ctx,
        [
          '<b>🟢 Send your buy amounts, in SOL.</b>',
          '',
          `Current: <b>${db.settings().quickBuyPresets.join(', ')}</b>`,
          '',
          '<i>Up to 5, separated by spaces or commas — e.g. 0.02 0.1 0.25 0.5 1</i>',
        ].join('\n'),
        backButton('settings'),
      );

    case 'set_sell_presets':
      setPending(userId, { kind: 'set_sell_presets' });
      return render(
        ctx,
        [
          '<b>🔴 Send your sell percentages.</b>',
          '',
          `Current: <b>${db.settings().quickSellPresets.join(', ')}</b>`,
          '',
          '<i>Up to 4, separated by spaces or commas — e.g. 20 50 80 100</i>',
        ].join('\n'),
        backButton('settings'),
      );
    case 'change_passphrase':
      setPending(userId, { kind: 'change_passphrase', stage: 'current' });
      return render(ctx, '<b>🔑 Send your current passphrase.</b>', backButton('settings'));

    case 'factory_reset':
      return showFactoryReset(ctx);

    default:
      await ctx.answerCallbackQuery({ text: 'Unknown action.', show_alert: false });
  }
}

// ── free text ─────────────────────────────────────────────────────────────────

function registerText(bot: Bot): void {
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return; // commands are handled above

    const userId = ctx.from.id;
    const pending = takePending(userId);

    // first run: whatever they send becomes the vault passphrase
    if (!vaultExists() && !pending) {
      await deleteMessage(ctx);
      try {
        await initVault(text);
        await ctx.reply('🔐 Vault created and unlocked.', { reply_markup: mainMenu() });
      } catch (err) {
        await ctx.reply(`❌ ${errMessage(err)}`);
      }
      return;
    }

    if (pending) {
      await handlePending(ctx, pending, text);
      return;
    }

    // Locked: treat whatever was sent as the passphrase rather than making the
    // operator type "/unlock " in front of it every time. The message is deleted
    // either way, so this costs nothing and removes the most repeated friction
    // in the whole bot.
    if (!isUnlocked()) {
      await deleteMessage(ctx);
      try {
        await unlockVault(text);
        await ctx.reply('🔓 Unlocked.', { reply_markup: mainMenu() });
      } catch {
        await ctx.reply('🔒 That did not unlock the vault. Send your passphrase again.');
      }
      return;
    }

    // the headline behaviour: paste an address, get the token
    const token = extractTokenAddress(text);
    if (token) {
      session(userId).lastTokenMint = token.address;
      await T.showTokenCard(ctx, token.address);
      return;
    }

    await ctx.reply('Send a token address, or open the menu.', { reply_markup: mainMenu() });
  });
}

async function handlePending(
  ctx: Context,
  pending: NonNullable<ReturnType<typeof takePending>>,
  text: string,
): Promise<void> {
  const userId = ctx.from!.id;

  switch (pending.kind) {
    case 'unlock':
    case 'create_vault': {
      await deleteMessage(ctx);
      try {
        if (vaultExists()) await unlockVault(text);
        else await initVault(text);
        await ctx.reply('🔓 Unlocked.', { reply_markup: mainMenu() });
      } catch (err) {
        await ctx.reply(`❌ ${errMessage(err)}`);
      }
      return;
    }

    case 'change_passphrase': {
      await deleteMessage(ctx);
      if (pending.stage === 'current') {
        setPending(userId, { kind: 'change_passphrase', stage: 'new', current: text });
        await ctx.reply('Now send the <b>new</b> passphrase.', { parse_mode: 'HTML' });
        return;
      }
      try {
        await changePassphrase(pending.current, text, resealAll);
        await ctx.reply('✅ Passphrase changed. Every stored key was re-encrypted under the new one.');
      } catch (err) {
        await ctx.reply(`❌ ${errMessage(err)}`);
      }
      return;
    }

    case 'import_key': {
      await deleteMessage(ctx);
      if (!(await requireUnlocked(ctx))) return;
      await W.handleImportKey(ctx, text);
      return;
    }

    case 'import_mnemonic': {
      await deleteMessage(ctx);
      if (!(await requireUnlocked(ctx))) return;
      await W.handleImportMnemonic(ctx, text);
      return;
    }

    case 'rename_wallet':
      return W.handleRename(ctx, pending.walletId, text);

    case 'group_wallet':
      return W.handleGroup(ctx, pending.walletId, text);

    case 'custom_buy': {
      const amount = Number(text);
      if (!Number.isFinite(amount) || amount <= 0) {
        await ctx.reply('That is not a valid SOL amount.');
        return;
      }
      return T.promptBuy(ctx, pending.mint, amount);
    }

    case 'custom_sell': {
      const pct = Number(text);
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
        await ctx.reply('Send a percentage between 1 and 100.');
        return;
      }
      return T.promptSell(ctx, pending.mint, pct);
    }

    case 'factory_reset': {
      // the phrase itself is not a secret, but the screen it came from is noisy
      await deleteMessage(ctx);
      return executeFactoryReset(ctx, text);
    }

    case 'copy_address':
      return T.handleCopyAddress(ctx, text);

    case 'copy_size': {
      const sol = Number(text);
      if (!Number.isFinite(sol) || sol <= 0) {
        await ctx.reply('That is not a valid SOL amount.');
        return;
      }
      return T.handleCopySize(ctx, pending.address, sol);
    }

    case 'fund_amount': {
      const sol = Number(text);
      if (!Number.isFinite(sol) || sol <= 0) {
        await ctx.reply('That is not a valid SOL amount.');
        return;
      }
      return T.promptFund(ctx, pending.mode, sol);
    }

    case 'send_to_address': {
      const token = extractTokenAddress(text);
      if (!token) {
        await ctx.reply('That does not look like a token address.');
        return;
      }
      return T.executeSweepToken(ctx, token.address);
    }

    case 'manual_token_lookup': {
      const token = extractTokenAddress(text);
      if (!token) {
        await ctx.reply('That does not look like a token address.');
        return;
      }
      return T.showTokenCard(ctx, token.address);
    }

    case 'set_slippage':
      return applyNumericSetting(ctx, text, 0.1, 100, (v) => {
        db.updateSettings({ slippagePercent: v });
        return `Slippage set to ${v}%`;
      });

    case 'set_priority_fee':
      return applyNumericSetting(ctx, text, 0, 1, (v) => {
        db.updateSettings({ priorityFeeSol: v });
        return `Priority fee set to ${v} SOL`;
      });

    case 'set_jito_tip':
      return applyNumericSetting(ctx, text, 0, 1, (v) => {
        db.updateSettings({ jitoTipSol: v });
        return `Jito tip set to ${v} SOL`;
      });

    case 'set_reserve':
      return applyNumericSetting(ctx, text, 0, 1, (v) => {
        db.updateSettings({ sweepReserveSol: v });
        return `Sweep reserve set to ${v} SOL`;
      });


    case 'set_fee_ceiling':
      return applyNumericSetting(ctx, text, 0.00001, 0.5, (v) => {
        db.updateSettings({ priorityFeeCeilingSol: v });
        return `Priority fee ceiling set to ${v} SOL`;
      });

    case 'set_buy_presets': {
      const values = parseNumberList(text, 5);
      if (!values || values.some((v) => v <= 0 || v > config.safety.maxBuySolPerWallet)) {
        await ctx.reply(
          `Send up to 5 amounts between 0 and ${config.safety.maxBuySolPerWallet} SOL, e.g. 0.02 0.1 0.5`,
        );
        return;
      }
      db.updateSettings({ quickBuyPresets: values });
      await ctx.reply(`✅ Buy buttons are now: ${values.join(', ')} SOL`, {
        reply_markup: new InlineKeyboard().text('⚙️ Settings', 'settings'),
      });
      return;
    }

    case 'set_sell_presets': {
      const values = parseNumberList(text, 4);
      if (!values || values.some((v) => v <= 0 || v > 100)) {
        await ctx.reply('Send up to 4 percentages between 1 and 100, e.g. 20 50 80 100');
        return;
      }
      db.updateSettings({ quickSellPresets: values });
      await ctx.reply(`✅ Sell buttons are now: ${values.join(', ')}%`, {
        reply_markup: new InlineKeyboard().text('⚙️ Settings', 'settings'),
      });
      return;
    }

    default:
      await ctx.reply('Nothing was waiting on that input.');
  }
}

/**
 * Parse "0.02 0.1, 0.5" into numbers. Returns undefined if anything in the list
 * is not a number, so a typo replaces nothing rather than silently dropping the
 * value it could not read.
 */
function parseNumberList(text: string, max: number): number[] | undefined {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0 || parts.length > max) return undefined;

  const values = parts.map(Number);
  if (values.some((v) => !Number.isFinite(v))) return undefined;

  return values;
}

async function applyNumericSetting(
  ctx: Context,
  text: string,
  min: number,
  max: number,
  apply: (value: number) => string,
): Promise<void> {
  const value = Number(text);
  if (!Number.isFinite(value) || value < min || value > max) {
    await ctx.reply(`Send a number between ${min} and ${max}.`);
    return;
  }
  await ctx.reply(`✅ ${apply(value)}`, {
    reply_markup: new InlineKeyboard().text('⚙️ Settings', 'settings'),
  });
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function requireUnlocked(ctx: Context): Promise<boolean> {
  if (isUnlocked()) return true;
  await ctx.reply('🔒 Vault is locked. Send /unlock <passphrase>.');
  return false;
}

/** Remove a message the operator sent that contained a secret. */
async function deleteMessage(ctx: Context): Promise<void> {
  try {
    await ctx.deleteMessage();
  } catch {
    // deletion fails for messages older than 48h, or without the right rights
  }
}

export { allWallets };
