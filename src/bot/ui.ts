import { InlineKeyboard } from 'grammy';
import { fmtAmount, fmtUsd, shortAddr, fmtDuration } from '../util.js';
import { tokenId, shortWalletId } from './session.js';
import type { Settings } from '../store/db.js';
import type { Portfolio } from '../services/portfolio.js';
import type { TokenInfo } from '../services/tokeninfo.js';
import type { BatchSummary, WalletRecord } from '../types.js';

/** Telegram HTML mode needs exactly these three escaped. */
export function h(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const SOLSCAN_TX = (sig: string) => `https://solscan.io/tx/${sig}`;
const SOLSCAN_ACC = (addr: string) => `https://solscan.io/account/${addr}`;

// ── main menu ─────────────────────────────────────────────────────────────────

/*
 * Button colour is a real Bot API field, not decoration for its own sake.
 *
 * `style` takes "success" (green), "danger" (red) or "primary" (blue), and is
 * used here to mean one thing consistently: green spends or opens a position,
 * red closes or destroys one, blue is everything that only reads. On a screen
 * where 🟢 Buy and 🔴 Sell sit next to each other, colour is the difference the
 * eye catches before the text, which is the point.
 */
export function mainMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text('💼 Portfolio', 'portfolio').primary()
    .text('🪙 Positions', 'positions').primary()
    .row()
    .text('👛 Wallets', 'wallets').primary()
    .text('💸 Move Funds', 'consolidate_menu').primary()
    .row()
    .text('👥 Copy Trade', 'copy_trade').success()
    .text('⚙️ Settings', 'settings');
}

export function backButton(to = 'home'): InlineKeyboard {
  return new InlineKeyboard().text('← Back', to);
}

// ── portfolio ─────────────────────────────────────────────────────────────────

export function renderPortfolio(p: Portfolio, group: string | null): string {
  const lines: string[] = [];

  lines.push('<b>💼 Portfolio</b>');
  if (group) lines.push(`<i>filtered to group: ${h(group)}</i>`);
  lines.push('');

  lines.push(`<b>Total value:  ${fmtUsd(p.totals.grandTotalUsd)}</b>`);
  lines.push('');

  if (p.mainSolana) {
    lines.push('<b>★ Main wallet (Solana)</b>');
    lines.push(`${h(p.mainSolana.label)} · <code>${shortAddr(p.mainSolana.address, 6, 6)}</code>`);
    lines.push(`${fmtAmount(p.mainSolana.sol, 4)} SOL · ${fmtUsd(p.mainSolana.usd)}`);
    lines.push('');
  }

  if (p.solana.length > 0) {
    const funded = p.solana.filter((b) => b.native > 0);
    lines.push(`<b>Solana</b> — ${fmtAmount(p.totals.solTotal, 4)} SOL · ${fmtUsd(p.totals.solUsd)}`);
    lines.push(`<i>${p.solana.length} wallets, ${funded.length} funded</i>`);

    // showing every wallet blows past Telegram's message limit past ~40 wallets
    for (const b of p.solana.slice(0, 15)) {
      const star = p.mainSolana?.address === b.address ? '★' : '·';
      const tokenNote = b.tokens.length > 0 ? ` <i>+${b.tokens.length} tok</i>` : '';
      lines.push(
        `${star} ${h(b.label)}  <code>${shortAddr(b.address)}</code>  ${fmtAmount(b.native, 4)}${tokenNote}`,
      );
    }
    if (p.solana.length > 15) lines.push(`<i>…and ${p.solana.length - 15} more</i>`);
    lines.push('');
  }

  if (p.totals.tokenUsd > 0) {
    lines.push('');
    lines.push(`<b>Token positions:</b> ${fmtUsd(p.totals.tokenUsd)}`);
  }

  if (p.errors.length > 0) {
    lines.push('');
    lines.push('<i>⚠️ ' + h(p.errors.slice(0, 3).join(' | ')) + '</i>');
  }

  return lines.join('\n');
}

/**
 * When the numbers on screen were read.
 *
 * A refresh that lands on unchanged data edits a message into itself, which
 * Telegram rejects as "message is not modified" — so the tap looks identical to
 * a broken button. A clock that always moves makes every refresh visibly land,
 * and answers the question the button is really asking: how old is this?
 *
 * UTC, and labelled, because the container runs UTC and a bare time next to a
 * phone showing something else is worse than no time at all.
 */
export function updatedStamp(): string {
  return `<i>updated ${new Date().toISOString().slice(11, 19)} UTC</i>`;
}

export function portfolioKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔄 Refresh', 'portfolio').primary()
    .text('🪙 Positions', 'positions').primary()
    .row()
    .text('💸 Sweep SOL → Main', 'sweep_sol_confirm')
    .row()
    .text('← Menu', 'home');
}

// ── token info card ───────────────────────────────────────────────────────────

export function renderTokenCard(info: TokenInfo): string {
  const lines: string[] = [];
  const name = info.name ?? 'Unknown token';
  const symbol = info.symbol ? ` ($${h(info.symbol)})` : '';

  lines.push(`<b>${h(name)}</b>${symbol}`);
  lines.push(`<code>${h(info.address)}</code>`);

  // which chain and venue this price actually comes from — the same address can
  // exist on several chains, so an unlabelled price is a guess
  const venue = [info.chainLabel, info.dex].filter(Boolean).join(' · ');
  if (venue) lines.push(`<i>${h(venue)}</i>`);

  lines.push('');

  if (info.priceUsd !== undefined) {
    const ch24 = info.priceChange24h;
    const arrow = ch24 === undefined ? '' : ch24 >= 0 ? ' 🟢' : ' 🔴';
    const chStr = ch24 === undefined ? '' : `  ${ch24 >= 0 ? '+' : ''}${ch24.toFixed(1)}% (24h)${arrow}`;
    lines.push(`💵 <b>$${formatPrice(info.priceUsd)}</b>${chStr}`);
  }

  if (info.marketCap !== undefined) lines.push(`📊 Market cap: <b>${fmtUsd(info.marketCap)}</b>`);
  if (info.fdv !== undefined && info.fdv !== info.marketCap) lines.push(`   FDV: ${fmtUsd(info.fdv)}`);
  if (info.liquidityUsd !== undefined) lines.push(`💧 Liquidity: ${fmtUsd(info.liquidityUsd)}`);

  if (info.volume24h !== undefined) {
    const v1 = info.volume1h !== undefined ? `  (1h: ${fmtUsd(info.volume1h)})` : '';
    lines.push(`📈 Volume 24h: ${fmtUsd(info.volume24h)}${v1}`);
  }

  if (info.buys24h !== undefined && info.sells24h !== undefined) {
    lines.push(`🔁 Txns 24h: ${info.buys24h} buys / ${info.sells24h} sells`);
  }

  // Authorities, stated either way. Silence here would read as "safe", which is
  // exactly the mistake this line exists to prevent.
  if (info.chain === 'solana') {
    const mint =
      info.mintAuthority === undefined ? '❓ unknown' : info.mintAuthority ? '⚠️ ACTIVE' : '✅ revoked';
    const freeze =
      info.freezeAuthority === undefined ? '❓ unknown' : info.freezeAuthority ? '🚨 ACTIVE' : '✅ revoked';
    lines.push('');
    lines.push(`🔒 Mint auth: ${mint}   ·   Freeze auth: ${freeze}`);
  }

  // pump.fun progress bar
  if (info.isPumpFun) {
    lines.push('');
    if (info.curveComplete) {
      lines.push('🎓 <b>Graduated</b> — trading on the AMM');
    } else if (info.curveProgressPct !== undefined) {
      lines.push(`🚀 <b>pump.fun</b> curve: ${progressBar(info.curveProgressPct)} ${info.curveProgressPct.toFixed(1)}%`);
      if (info.curveMcapSol !== undefined) {
        lines.push(`   Curve mcap: ${fmtAmount(info.curveMcapSol, 2)} SOL`);
      }
    }

    // the launch wallet's remaining stake — the clearest rug signal pump.fun gives
    if (info.creator) {
      const stake =
        info.creatorHoldsPct === undefined
          ? '❓ unknown'
          : info.creatorHoldsPct === 0
            ? '✅ sold out / holds none'
            : `${info.creatorHoldsPct >= 5 ? '⚠️' : '·'} ${info.creatorHoldsPct.toFixed(2)}% of supply`;
      lines.push(`👤 Dev <a href="${SOLSCAN_ACC(info.creator)}">${shortAddr(info.creator, 4, 4)}</a> holds: ${stake}`);
    }
  }

  // holder distribution
  if (info.holdersUnavailable) {
    lines.push('');
    lines.push('<b>👥 Top holders</b>');
    lines.push('<i>Unavailable — RPC rejected the query. Use a private endpoint.</i>');
  } else if (info.holders && info.holders.length > 0) {
    lines.push('');
    lines.push('<b>👥 Top holders</b>');
    if (info.top10Pct !== undefined) {
      lines.push(`Top 10 hold <b>${info.top10Pct.toFixed(1)}%</b> of supply`);
    }

    const shown = info.holders.filter((x) => x.tag !== 'bonding curve').slice(0, 5);
    for (const [i, hold] of shown.entries()) {
      const tag = hold.tag ? ` <i>(${h(hold.tag)})</i>` : '';
      lines.push(
        `${i + 1}. <code>${shortAddr(hold.owner, 4, 4)}</code> — ${hold.pctOfSupply.toFixed(2)}%${tag}`,
      );
    }
  }

  if (info.ownedAmount !== undefined && info.ownedAmount > 0) {
    lines.push('');
    lines.push(
      `<b>📦 Your wallets hold:</b> ${fmtAmount(info.ownedAmount, 2)} (${(info.ownedPct ?? 0).toFixed(2)}% of supply)`,
    );
  }

  if (info.warnings.length > 0) {
    lines.push('');
    for (const w of info.warnings.slice(0, 4)) lines.push(`⚠️ <i>${h(w)}</i>`);
  }

  return lines.join('\n');
}

function formatPrice(p: number): string {
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.0001) return p.toFixed(8);
  // sub-cent memecoin pricing needs the exponent to stay readable
  return p.toExponential(4);
}

function progressBar(pct: number, width = 10): string {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function tokenKeyboard(mint: string, settings: Settings, holdsPosition: boolean): InlineKeyboard {
  const id = tokenId(mint);
  const kb = new InlineKeyboard();

  // buy row(s) — presets across every selected wallet
  const buys = settings.quickBuyPresets.slice(0, 5);
  for (const [i, amount] of buys.entries()) {
    kb.text(`🟢 ${amount}◎`, `buy:${id}:${amount}`).success();
    if ((i + 1) % 3 === 0) kb.row();
  }
  kb.row();
  kb.text('💰 Custom buy', `buycustom:${id}`).success();

  if (holdsPosition) {
    kb.row();
    for (const pct of settings.quickSellPresets.slice(0, 4)) {
      kb.text(`${pct}%`, `sell:${id}:${pct}`).danger();
    }
    kb.row();
    kb.text('🔥 Sell it all', `sell:${id}:100`).danger();
  }

  kb.row();
  kb.text('🤖 Automation', `autosell:${id}`).primary()
    .text('👥 Holders', `holders:${id}`).primary();
  kb.row();
  kb.text('🔄 Refresh', `tokeninfo:${id}`).primary()
    .url('📈 Chart', `https://dexscreener.com/search?q=${mint}`)
    .text('← Menu', 'home');

  return kb;
}

export function renderHolders(info: TokenInfo): string {
  const lines: string[] = [`<b>👥 Holder distribution</b>`, `<code>${h(info.address)}</code>`, ''];

  if (!info.holders || info.holders.length === 0) {
    lines.push('<i>No holder data available for this token.</i>');
    return lines.join('\n');
  }

  if (info.totalSupply) lines.push(`Total supply: ${fmtAmount(info.totalSupply, 0)}`);
  if (info.top10Pct !== undefined) lines.push(`Top 10 (excluding pools): <b>${info.top10Pct.toFixed(2)}%</b>`);
  lines.push('');

  for (const [i, hold] of info.holders.slice(0, 20).entries()) {
    const tag = hold.tag ? ` <i>(${h(hold.tag)})</i>` : '';
    lines.push(
      `${String(i + 1).padStart(2)}. <a href="${SOLSCAN_ACC(hold.owner)}">${shortAddr(hold.owner, 4, 4)}</a>` +
        `  ${hold.pctOfSupply.toFixed(2)}%  ${fmtAmount(hold.amount, 0)}${tag}`,
    );
  }

  return lines.join('\n');
}

// ── wallets ───────────────────────────────────────────────────────────────────

export function renderWalletList(wallets: WalletRecord[], activeGroup: string | null): string {
  const lines: string[] = ['<b>👛 Wallets</b>'];
  if (activeGroup) lines.push(`<i>batch actions target group: ${h(activeGroup)}</i>`);
  lines.push('');

  if (wallets.length > 0) {
    lines.push(`<b>Solana</b> (${wallets.length})`);
    for (const w of wallets.slice(0, 25)) {
      const flags = [w.isMain ? '★ main' : '', w.disabled ? '⏸ off' : '', ...w.groups]
        .filter(Boolean)
        .join(', ');
      lines.push(`· <b>${h(w.label)}</b> <code>${shortAddr(w.address, 5, 5)}</code>${flags ? ` — <i>${h(flags)}</i>` : ''}`);
    }
    if (wallets.length > 25) lines.push(`<i>…and ${wallets.length - 25} more</i>`);
    lines.push('');
  }

  if (wallets.length === 0) lines.push('<i>No wallets yet. Generate or import one below.</i>');

  return lines.join('\n');
}

export function walletsKeyboard(wallets: WalletRecord[]): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('➕ New wallet', 'gen').text('🌱 Derive HD set', 'derive_menu')
    .row()
    .text('📥 Import key', 'import_key')
    .row()
    .text('🏷 Manage', 'wallet_manage').text('🎯 Group filter', 'group_filter')
    .row();

  if (wallets.length > 0) kb.text('📤 Export addresses', 'export_addresses').row();

  return kb.text('← Menu', 'home');
}

export function walletManageKeyboard(wallets: WalletRecord[]): InlineKeyboard {
  const kb = new InlineKeyboard();

  for (const w of wallets.slice(0, 20)) {
    const id = shortWalletId(w.id);
    const mark = w.isMain ? '★' : w.disabled ? '⏸' : '·';
    kb.text(`${mark} ${w.label}`, `wallet:${id}`).row();
  }

  return kb.text('← Back', 'wallets');
}

export function walletDetailKeyboard(w: WalletRecord): InlineKeyboard {
  const id = shortWalletId(w.id);
  return new InlineKeyboard()
    .text('★ Set as main', `setmain:${id}`).text('🏷 Rename', `rename:${id}`)
    .row()
    .text(w.disabled ? '▶️ Enable' : '⏸ Disable', `toggle:${id}`).text('🏷 Group', `group:${id}`)
    .row()
    .text('🔑 Export key', `export:${id}`).text('🗑 Remove', `remove:${id}`)
    .row()
    .text('← Back', 'wallet_manage');
}

// ── batch results ─────────────────────────────────────────────────────────────

export function renderBatchSummary(title: string, summary: BatchSummary): string {
  const lines: string[] = [`<b>${h(title)}</b>`, ''];
  const elapsed = fmtDuration(summary.finishedAt - summary.startedAt);

  lines.push(`✅ ${summary.succeeded} succeeded   ❌ ${summary.failed} failed   ⏱ ${elapsed}`);
  lines.push('');

  const shown = summary.results.slice(0, 20);
  for (const r of shown) {
    const icon = r.ok ? '✅' : '❌';
    const link = r.signature ? ` <a href="${SOLSCAN_TX(r.signature)}">tx</a>` : '';
    const note = r.ok ? (r.detail ? ` — ${h(r.detail)}` : '') : ` — <i>${h(truncate(r.error ?? 'failed', 70))}</i>`;
    lines.push(`${icon} <b>${h(r.label)}</b>${note}${link}`);
  }

  if (summary.results.length > shown.length) {
    lines.push(`<i>…and ${summary.results.length - shown.length} more</i>`);
  }

  return lines.join('\n');
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

// ── settings ──────────────────────────────────────────────────────────────────

export function renderSettings(s: Settings, walletCount: number): string {
  return [
    '<b>⚙️ Settings</b>',
    '',
    `Slippage: <b>${s.slippagePercent}%</b>`,
    `Priority fee: <b>${s.priorityFeeSol} SOL</b>` +
      (s.priorityFeeMode === 'auto' ? ` <i>(auto, up to ${s.priorityFeeCeilingSol})</i>` : ' <i>(fixed)</i>'),
    `Execution mode: <b>${s.executionMode}</b>`,
    `Jito tip: <b>${s.jitoTipSol} SOL</b> <i>(bundle mode only)</i>`,
    `Sweep reserve: <b>${s.sweepReserveSol} SOL</b> <i>(left in each wallet)</i>`,
    `Active group: <b>${s.activeGroup ? h(s.activeGroup) : 'all wallets'}</b>`,
    '',
    `Quick buys: ${s.quickBuyPresets.join(', ')} SOL`,
    `Quick sells: ${s.quickSellPresets.join(', ')}%`,
    '',
    `Wallets: ${walletCount}`,
  ].join('\n');
}

export function settingsKeyboard(s: Settings, legacyCount = 0): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('Slippage', 'set_slippage').text('Priority fee', 'set_priority_fee')
    .row()
    .text(`Fee mode: ${s.priorityFeeMode}`, 'toggle_fee_mode').text('Fee ceiling', 'set_fee_ceiling')
    .row()
    .text(`Mode: ${s.executionMode}`, 'toggle_mode').text('Jito tip', 'set_jito_tip')
    .row()
    .text('Sweep reserve', 'set_reserve').text('Group filter', 'group_filter')
    .row()
    .text('🟢 Buy presets', 'set_buy_presets').text('🔴 Sell presets', 'set_sell_presets')
    .row()

  // only on the installs that actually carry them, so nobody else sees the row
  if (legacyCount > 0) kb.text(`📦 Export legacy keys (${legacyCount})`, 'legacy_keys').row();

  return kb.text('🧨 Factory reset', 'factory_reset').row().text('← Menu', 'home');
}

// ── confirmation ──────────────────────────────────────────────────────────────

export function confirmKeyboard(confirmId: string, cancelTo = 'home'): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Confirm', `confirm:${confirmId}`).success()
    .text('✖️ Cancel', cancelTo);
}

export function progressBarText(done: number, total: number): string {
  if (total === 0) return '';
  const pct = Math.round((done / total) * 100);
  return `${progressBar(pct, 12)} ${done}/${total}`;
}
