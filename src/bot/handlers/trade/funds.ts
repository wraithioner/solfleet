import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { config } from '../../../config.js';
import { db } from '../../../store/db.js';
import { selectWallets, mainWallet } from '../../../store/wallets.js';
import { getSolBalance, LAMPORTS } from '../../../chains/solana.js';
import { batchSweepSol, batchSweepToken } from '../../../trade/engine.js';
import {
  planFunding,
  executeFunding,
  fundingBalances,
  requiredForBuy,
  type FundMode,
  type FundPlan,
} from '../../../trade/fund.js';
import { errMessage, fmtAmount, shortAddr } from '../../../util.js';
import { stageConfirmation, setPending } from '../../session.js';
import { renderBatchSummary, confirmKeyboard, backButton, h } from '../../ui.js';
import { render } from '../core.js';
import { withExecution } from '../../../services/execution.js';
import { throttledProgress } from './progress.js';

// ── consolidation ─────────────────────────────────────────────────────────────

export async function showConsolidateMenu(ctx: Context): Promise<void> {
  const mainSol = mainWallet();

  const lines = ['<b>💸 Move funds</b>', ''];
  lines.push(
    mainSol
      ? `Solana main: <b>${h(mainSol.label)}</b> <code>${shortAddr(mainSol.address, 6, 6)}</code>`
      : '<i>No Solana main wallet set.</i>',
  );
  lines.push('');
  lines.push(
    `<i>Sweeps leave ${db.settings().sweepReserveSol} SOL in each wallet for future fees.</i>`,
  );

  const kb = new InlineKeyboard();
  if (mainSol) kb.text('⬇️ Fund wallets from main', 'fund_menu').row();
  if (mainSol) kb.text('◎ Sweep all SOL → main', 'sweep_sol_confirm').row();
  if (mainSol) kb.text('🪙 Sweep a token → main', 'sweep_token_prompt').row();

  kb.text('← Menu', 'home');
  await render(ctx, lines.join('\n'), kb);
}

// ── funding: main wallet → every trading wallet ───────────────────────────────

export async function showFundMenu(ctx: Context): Promise<void> {
  const main = mainWallet();
  if (!main) {
    await ctx.answerCallbackQuery({ text: 'Set a main Solana wallet first.', show_alert: true });
    return;
  }

  await render(ctx, '<b>⬇️ Fund wallets from main</b>\n\n<i>Reading balances…</i>');

  const targets = selectWallets({ excludeMain: true });

  let balanceLine = '';
  try {
    const { sol } = await getSolBalance(main.address);
    balanceLine = `Main wallet holds <b>${fmtAmount(sol, 4)} SOL</b>`;
  } catch {
    balanceLine = '<i>Could not read the main wallet balance.</i>';
  }

  const settings = db.settings();
  const buyPreset = settings.quickBuyPresets[0] ?? 0.05;
  const neededPerWallet = requiredForBuy(buyPreset, settings.priorityFeeSol, {
    jitoTipSol: settings.executionMode === 'bundle' ? settings.jitoTipSol : 0,
  });

  await render(
    ctx,
    [
      '<b>⬇️ Fund wallets from main</b>',
      '',
      balanceLine,
      `Targets: <b>${targets.length}</b> wallets${db.settings().activeGroup ? ` in <i>${h(db.settings().activeGroup!)}</i>` : ''}`,
      '',
      '<b>Send each</b> — every wallet receives the same amount, on top of whatever it already has.',
      '<b>Top up each to</b> — every wallet is brought <i>up to</i> the amount. Wallets already there are skipped.',
      '',
      // funding a wallet with exactly the buy size is the classic mistake: it
      // fills, and then there is nothing left to pay for the way out
      `<i>To buy <b>${buyPreset}</b> SOL a wallet needs <b>${fmtAmount(Number(neededPerWallet) / LAMPORTS, 4)}</b> — ` +
        'the trade, its fees, the token account rent, and enough kept back to sell.</i>',
      '',
      '<i>Transfers are packed into batched transactions, so fifty wallets cost a handful of fees rather than fifty.</i>',
    ].join('\n'),
    new InlineKeyboard()
      .text('◎ Send each…', 'fund:each')
      .text('◎ Top up each to…', 'fund:topup')
      .row()
      .text('← Back', 'consolidate_menu'),
  );
}

export async function promptFundAmount(ctx: Context, mode: FundMode): Promise<void> {
  setPending(ctx.from!.id, { kind: 'fund_amount', mode });

  await render(
    ctx,
    mode === 'each'
      ? '<b>⬇️ Send how much SOL to each wallet?</b>\n\n<i>e.g. 0.1</i>'
      : '<b>⬇️ Top every wallet up to how much SOL?</b>\n\n<i>e.g. 0.5 — wallets already holding that much are skipped.</i>',
    backButton('fund_menu'),
  );
}

export async function promptFund(ctx: Context, mode: FundMode, sol: number): Promise<void> {
  const main = mainWallet();
  if (!main) {
    await ctx.reply('Set a main Solana wallet first.');
    return;
  }

  const targets = selectWallets({ excludeMain: true });
  if (targets.length === 0) {
    await ctx.reply('No wallets to fund. Generate or derive some first.');
    return;
  }

  const settings = db.settings();

  let plan: FundPlan;
  try {
    const [balances, source] = await Promise.all([
      // a top-up needs to know what each wallet already holds; sending a flat
      // amount does not, but the numbers cost one call either way
      fundingBalances(targets.map(w => w.address)),
      getSolBalance(main.address),
    ]);

    plan = planFunding({
      targets,
      balances,
      mode,
      sol,
      sourceLamports: source.lamports,
      priorityFeeSol: settings.priorityFeeSol,
      reserveSol: settings.sweepReserveSol,
    });
  } catch (err) {
    await ctx.reply(`❌ ${errMessage(err)}`, { reply_markup: backButton('fund_menu') });
    return;
  }

  if (plan.transfers.length === 0) {
    await ctx.reply(
      mode === 'topup'
        ? `Every wallet already holds at least ${sol} SOL. Nothing to do.`
        : 'Nothing to send — the amount is below the transfer fee.',
      { reply_markup: backButton('fund_menu') },
    );
    return;
  }

  const total = Number(plan.totalLamports) / LAMPORTS;
  const fees = Number(plan.feeLamports) / LAMPORTS;

  const lines = [
    '<b>⬇️ Confirm funding</b>',
    '',
    `From: <b>${h(main.label)}</b> <code>${shortAddr(main.address, 6, 6)}</code>`,
    `To: <b>${plan.transfers.length}</b> wallets`,
    mode === 'each' ? `Amount: <b>${sol} SOL</b> each` : `Topping up to: <b>${sol} SOL</b> each`,
    `Total: <b>${fmtAmount(total, 6)} SOL</b> + ~${fmtAmount(fees, 6)} SOL fees`,
    `Transactions: ${plan.txCount}`,
  ];

  if (plan.skipped.length > 0) {
    lines.push('');
    lines.push(
      `<i>${plan.skipped.length} wallet${plan.skipped.length === 1 ? '' : 's'} skipped — already funded.</i>`,
    );
  }

  const run = async (ctx: Context) =>
    withExecution(async () => {
      await render(ctx, `<b>⬇️ Funding ${plan.transfers.length} wallets…</b>`);

      try {
        // A confirmation may wait while trades change both sides of the plan.
        // Recompute under the operation gate, shrinking a top-up if funds arrived
        // and refusing a larger transfer than the operator saw on screen.
        const [balances, source] = await Promise.all([
          fundingBalances(plan.transfers.map(t => t.address)),
          getSolBalance(main.address),
        ]);
        const currentPlan = planFunding({
          targets: plan.transfers.map(t => ({
            id: t.walletId,
            address: t.address,
            label: t.label,
          })),
          balances,
          mode,
          sol,
          sourceLamports: source.lamports,
          priorityFeeSol: settings.priorityFeeSol,
          reserveSol: settings.sweepReserveSol,
        });
        if (
          currentPlan.transfers.some(
            t =>
              t.lamports >
              (plan.transfers.find(old => old.walletId === t.walletId)?.lamports ?? 0n),
          )
        ) {
          throw new Error(
            'Wallet balances changed and this needs a larger transfer. Start funding again.',
          );
        }
        const summary = await executeFunding(
          main,
          currentPlan,
          settings.priorityFeeSol,
          throttledProgress(ctx, 'Funding wallets'),
        );

        db.appendTradeLog({
          at: Date.now(),
          action: mode === 'each' ? `fund ${sol} SOL each` : `top up to ${sol} SOL`,
          walletCount: plan.transfers.length,
          succeeded: summary.succeeded,
          failed: summary.failed,
        });

        await render(
          ctx,
          renderBatchSummary(`⬇️ Funded ${plan.transfers.length} wallets`, summary),
          new InlineKeyboard().text('💼 Portfolio', 'portfolio').row().text('← Menu', 'home'),
        );
      } catch (err) {
        await render(ctx, `❌ ${h(errMessage(err))}`, backButton('fund_menu'));
      }
    });

  if (!config.safety.requireConfirmation) {
    await run(ctx);
    return;
  }

  const id = stageConfirmation(ctx.from!.id, `fund ${plan.transfers.length} wallets`, run);
  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: confirmKeyboard(id, 'fund_menu'),
  });
}

export async function promptSweepSol(ctx: Context): Promise<void> {
  const main = mainWallet();
  if (!main) {
    await ctx.answerCallbackQuery({ text: 'Set a main Solana wallet first.', show_alert: true });
    return;
  }

  const settings = db.settings();
  const wallets = selectWallets({ excludeMain: true });

  if (wallets.length === 0) {
    await ctx.answerCallbackQuery({ text: 'No wallets to sweep from.', show_alert: true });
    return;
  }

  const run = async (ctx: Context) =>
    withExecution(async () => {
      await render(ctx, `<b>💸 Sweeping ${wallets.length} wallets…</b>`);
      try {
        const summary = await batchSweepSol(
          wallets,
          main.address,
          throttledProgress(ctx, 'Sweeping SOL'),
        );

        db.appendTradeLog({
          at: Date.now(),
          action: 'sweep SOL',
          walletCount: wallets.length,
          succeeded: summary.succeeded,
          failed: summary.failed,
        });

        await render(
          ctx,
          renderBatchSummary(`💸 Swept SOL → ${main.label}`, summary),
          new InlineKeyboard().text('💼 Portfolio', 'portfolio').row().text('← Menu', 'home'),
        );
      } catch (err) {
        await render(ctx, `❌ ${h(errMessage(err))}`, backButton());
      }
    });

  const id = stageConfirmation(ctx.from!.id, 'sweep SOL', run);

  await render(
    ctx,
    [
      '<b>💸 Sweep all SOL to main wallet</b>',
      '',
      `From: <b>${wallets.length}</b> wallets`,
      `To: <b>${h(main.label)}</b> <code>${shortAddr(main.address, 6, 6)}</code>`,
      `Reserve kept per wallet: <b>${settings.sweepReserveSol} SOL</b>`,
      '',
      '<i>Wallets holding less than the fee are skipped, not failed.</i>',
    ].join('\n'),
    confirmKeyboard(id),
  );
}

export async function promptSweepToken(ctx: Context): Promise<void> {
  setPending(ctx.from!.id, { kind: 'send_to_address' });
  await render(
    ctx,
    [
      '<b>🪙 Sweep a token to the main wallet</b>',
      '',
      'Send the token mint address now.',
      '',
      '<i>Every selected wallet transfers its full balance of that token, and the emptied token account is closed to reclaim its rent.</i>',
    ].join('\n'),
    backButton('consolidate_menu'),
  );
}

export async function executeSweepToken(ctx: Context, mint: string): Promise<void> {
  return withExecution(() => executeSweepTokenLocked(ctx, mint));
}

async function executeSweepTokenLocked(ctx: Context, mint: string): Promise<void> {
  const main = mainWallet();
  if (!main) {
    await ctx.reply('Set a main Solana wallet first.');
    return;
  }

  const wallets = selectWallets({ excludeMain: true });
  const msg = await ctx.reply(`<b>🪙 Sweeping token across ${wallets.length} wallets…</b>`, {
    parse_mode: 'HTML',
  });

  try {
    const summary = await batchSweepToken(wallets, mint, main.address);
    await ctx.api.editMessageText(
      msg.chat.id,
      msg.message_id,
      renderBatchSummary(`🪙 Swept token → ${main.label}`, summary),
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('← Menu', 'home') },
    );
  } catch (err) {
    await ctx.reply(`❌ ${errMessage(err)}`);
  }
}
