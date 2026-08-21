import { InlineKeyboard } from 'grammy';
import {
  fmtAmount,
  fmtUsd,
  fmtUsdShort,
  fmtPriceUsd,
  fmtChange,
  fmtCount,
  shortAddr,
  fmtDuration,
} from '../util.js';
import { tokenId, shortWalletId } from './session.js';
import type { Settings, ValueMark, CopyDecision } from '../store/db.js';
import { formatAccountPnl, markAgo, formatValueChange, type AccountPnl } from '../services/pnl.js';
import type { Portfolio } from '../services/portfolio.js';
import type { TokenInfo } from '../services/tokeninfo.js';
import { assessToken, DEFAULT_SAFETY, formatAge, type SafetyLimits } from '../services/safety.js';
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
    .text('📈 P&L', 'pnl').primary()
    .text('👛 Wallets', 'wallets').primary()
    .row()
    .text('💸 Move Funds', 'consolidate_menu').primary()
    .text('👥 Copy Trade', 'copy_trade').success()
    .row()
    .text('⚙️ Settings', 'settings');
}

export function backButton(to = 'home'): InlineKeyboard {
  return new InlineKeyboard().text('← Back', to);
}

// ── portfolio ─────────────────────────────────────────────────────────────────

export function renderPortfolio(p: Portfolio, group: string | null, pnl?: AccountPnl): string {
  const lines: string[] = [];

  lines.push('<b>💼 Portfolio</b>');
  if (group) lines.push(`<i>group: ${h(group)}</i>`);
  lines.push('');

  // the one number the screen exists to show, given the room to be seen
  lines.push(`<b>${fmtUsd(p.totals.grandTotalUsd)}</b>`);
  const split = [
    `${fmtAmount(p.totals.solTotal, 4)} ◎`,
    p.totals.tokenUsd > 0 ? `${fmtUsd(p.totals.tokenUsd)} in tokens` : '',
  ].filter(Boolean);
  lines.push(`<i>${split.join('  ·  ')}</i>`);
  lines.push('');

  /*
   * A balance is not a result.
   *
   * This screen used to show what the wallets are worth and stop there, which
   * leaves the only question that matters — am I up? — to the operator's memory
   * of what they put in. Nobody remembers. One line, directly under the number
   * it qualifies, and the full working is a tap away.
   */
  if (pnl && !pnl.empty) {
    lines.push(formatAccountPnl(pnl));
    lines.push(`<i>on ${fmtAmount(pnl.costSol, 4)} ◎ traded</i>`);
    lines.push('');
  }

  if (p.mainSolana) {
    lines.push(
      `★ <b>${h(p.mainSolana.label)}</b>  ${fmtAmount(p.mainSolana.sol, 4)} ◎  <i>${fmtUsd(p.mainSolana.usd)}</i>`,
    );
    lines.push(`   <code>${shortAddr(p.mainSolana.address, 6, 6)}</code>`);
    lines.push('');
  }

  if (p.solana.length > 0) {
    const funded = p.solana.filter((b) => b.native > 0);
    lines.push(`<b>👛 Wallets</b>  ${funded.length}/${p.solana.length} funded`);

    // showing every wallet blows past Telegram's message limit past ~40 wallets
    for (const b of p.solana.slice(0, 15)) {
      if (p.mainSolana?.address === b.address) continue; // already shown above
      const tokenNote = b.tokens.length > 0 ? `  <i>+${b.tokens.length} tok</i>` : '';
      const sol = fmtAmount(b.native, 4).padStart(8);
      lines.push(`   <code>${sol} ◎</code>  ${h(b.label)}${tokenNote}`);
    }
    if (p.solana.length > 15) lines.push(`   <i>…and ${p.solana.length - 15} more</i>`);
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
    .text('📈 P&L', 'pnl').primary()
    .text('💸 Sweep SOL → Main', 'sweep_sol_confirm')
    .row()
    .text('← Menu', 'home');
}

// ── profit and loss ───────────────────────────────────────────────────────────

/** Right-aligned in a monospace span, because a column of numbers should read as one. */
function solCell(n: number, width = 9): string {
  const sign = n < 0 ? '−' : '';
  return `<code>${(sign + Math.abs(n).toFixed(4)).padStart(width)} ◎</code>`;
}

/**
 * The full working behind the one line on the portfolio card.
 *
 * Two sections that must not be confused with one another. Traded P&L is what
 * the buying and selling did, and no deposit or withdrawal can move it. Account
 * value is what the wallets are worth over time, and sending yourself SOL moves
 * it a lot. Both are worth knowing; presenting either as the other is how a
 * losing month reads as a good one.
 */
export function renderPnl(a: AccountPnl, marks: ValueMark[], currentUsd: number): string {
  const lines: string[] = ['<b>📈 Profit &amp; loss</b>', ''];

  if (a.empty) {
    lines.push('<i>Nothing bought through this bot yet, so there is no result to report.</i>', '');
  } else {
    lines.push(formatAccountPnl(a), '');

    lines.push('<b>Traded</b>');
    lines.push(`   ${solCell(a.costSol)}  spent`);
    lines.push(`   ${solCell(a.realisedSol)}  sold back`);
    if (a.openValueSol > 0) lines.push(`   ${solCell(a.openValueSol)}  still open`);
    if (a.unpricedCount > 0) {
      lines.push(
        `   ${solCell(a.unpricedCostSol)}  <i>in ${a.unpricedCount} position${a.unpricedCount === 1 ? '' : 's'} nothing would price</i>`,
      );
    }
    if (a.feesSol > 0) lines.push(`   ${solCell(a.feesSol)}  <i>fees &amp; rent, included above</i>`);
    lines.push('');

    /*
     * Banked is the number that survives the worst case.
     *
     * A headline P&L carried by an open position is a claim about a price
     * somebody else has to agree to pay. This one is SOL that has already
     * arrived, and on an illiquid memecoin the difference between the two is
     * the whole story.
     */
    if (a.openValueSol > 0) {
      const banked = a.realisedNetSol;
      lines.push(
        `<b>Banked</b>  ${banked >= 0 ? '🟢' : '🔴'} ${banked >= 0 ? '+' : '−'}${Math.abs(banked).toFixed(4)} ◎` +
          `   <i>already sold</i>`,
      );
    }

    const traded = a.wins + a.losses;
    if (traded > 0) {
      lines.push(
        `<b>Record</b>  ${a.wins} up · ${a.losses} down` +
          `   <i>${a.openCount} open, ${a.closedCount} closed</i>`,
      );
    }
    lines.push('');

    if (a.best && a.best.netSol > 0) {
      lines.push(`🏆 <b>${h(a.best.symbol)}</b>  +${a.best.netSol.toFixed(4)} ◎  (+${a.best.netPct.toFixed(0)}%)`);
    }
    if (a.worst && a.worst.netSol < 0) {
      lines.push(
        `💀 <b>${h(a.worst.symbol)}</b>  −${Math.abs(a.worst.netSol).toFixed(4)} ◎  (−${Math.abs(a.worst.netPct).toFixed(0)}%)`,
      );
    }
    if ((a.best && a.best.netSol > 0) || (a.worst && a.worst.netSol < 0)) lines.push('');
  }

  if (!a.empty && a.unpricedCount > 0) {
    lines.push(
      `<i>The total leaves out ${a.unpricedCount === 1 ? 'a position' : `${a.unpricedCount} positions`} no venue ` +
        'would quote. Counting them as zero would be a guess that they are worthless.</i>',
      '',
    );
  }

  const windows: Array<[string, number]> = [
    ['24h', 86_400_000],
    ['7d', 7 * 86_400_000],
    ['30d', 30 * 86_400_000],
  ];
  const history = windows
    .map(([label, ms]) => {
      const mark = markAgo(marks, ms);
      // the label sits in a monospace cell so 24h, 7d and 30d line up
      return mark ? `   <code>${label.padEnd(4)}</code>${formatValueChange(mark, currentUsd)}` : null;
    })
    .filter((l): l is string => l !== null);

  lines.push('<b>💰 Account value</b>');
  if (history.length > 0) {
    lines.push(...history);
    lines.push('<i>Everything the wallets hold — deposits and withdrawals move this too.</i>');
  } else {
    lines.push(`   ${fmtUsd(currentUsd)} <i>now</i>`);
    lines.push('<i>Checked hourly. Come back tomorrow and this will show the change.</i>');
  }

  return lines.join('\n');
}

export function pnlKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔄 Refresh', 'pnl').primary()
    .text('🪙 Positions', 'positions').primary()
    .row()
    // reads past sales back off the chain, for the ones that were never
    // recorded — money that arrived while nothing was writing it down
    .text('🔧 Rebuild from chain', 'pnl_rebuild')
    .row()
    .text('💼 Portfolio', 'portfolio').primary()
    .text('← Menu', 'home');
}

/**
 * Why the bot did not act on a trade you watched it see.
 *
 * The question this answers came from watching a followed wallet buy something
 * and seeing nothing happen — which from the outside is indistinguishable from
 * the bot being asleep. Every one of these decisions was already being made and
 * written to a log file nobody can read.
 */
export function renderCopyDecisions(entries: CopyDecision[]): string {
  const lines = ['<b>📋 Recent copy decisions</b>', ''];

  if (entries.length === 0) {
    lines.push('<i>Nothing skipped recently. Every trade your wallets made was mirrored.</i>');
    return lines.join('\n');
  }

  lines.push('<i>Trades the bot saw and chose not to copy, newest first.</i>', '');

  /*
   * The full mint, not a shortened one.
   *
   * These skips used to arrive as Telegram messages, which carried the address
   * in a tappable block; they were moved here because a skip is not news. That
   * makes this the only place the address exists, and a truncated one cannot be
   * pasted into a chart to see what was passed up.
   */
  for (const e of entries) {
    const when = fmtAge(Date.now() - e.at);
    lines.push(`<b>${h(e.symbol ?? shortAddr(e.mint, 4, 4))}</b>  <i>${when} ago · ${h(e.target)}</i>`);
    lines.push(`   ${h(e.reason)}`);
    lines.push(`   <code>${h(e.mint)}</code>`);
  }

  lines.push('', '<i>A skip is usually the limits working. Copy trading → Safety to change them.</i>');
  return lines.join('\n');
}

export function copyDecisionsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔄 Refresh', 'copy_decisions').primary()
    .text('🛡 Safety', 'copy_safety').primary()
    .row()
    .text('← Copy trading', 'copy_trade');
}

// ── token info card ───────────────────────────────────────────────────────────

/**
 * Green under the limit, red over, grey when nobody could tell us.
 *
 * Grey is its own state on purpose. A missing number is not a passing one, and
 * showing it as a blank invites the reader to fill it in with the answer they
 * were hoping for.
 */
function judged(value: number | undefined, limit: number, unit = '%', decimals = 1): string {
  if (value === undefined) return '⚪️ unknown';
  const light = value > limit ? '🔴' : '🟢';
  return `${light} <b>${value.toFixed(decimals)}${unit}</b>`;
}

export function renderTokenCard(info: TokenInfo, limits = DEFAULT_SAFETY): string {
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

  /*
   * The price is the headline, so it gets the line to itself with both moves
   * beside it. 1h and 24h together is the difference between "down 8% today"
   * and "down 8% today and falling right now", which are not the same trade.
   */
  if (info.priceUsd !== undefined) {
    const moves = [
      info.priceChange1h !== undefined ? `1h ${fmtChange(info.priceChange1h)}` : '',
      info.priceChange24h !== undefined ? `24h ${fmtChange(info.priceChange24h)}` : '',
    ].filter(Boolean);
    lines.push(`💵 <b>${fmtPriceUsd(info.priceUsd)}</b>`);
    if (moves.length > 0) lines.push(`     ${moves.join('   ')}`);
  }

  // aligned labels so the numbers form a column the eye can run down
  if (info.marketCap !== undefined) {
    const fdv = info.fdv !== undefined && info.fdv !== info.marketCap ? `  <i>fdv ${fmtUsdShort(info.fdv)}</i>` : '';
    lines.push(`📊 Mcap      <b>${fmtUsdShort(info.marketCap)}</b>${fdv}`);
  }
  if (info.liquidityUsd !== undefined) lines.push(`💧 Liquidity  ${fmtUsdShort(info.liquidityUsd)}`);
  if (info.volume24h !== undefined) {
    const v1 = info.volume1h !== undefined ? `  <i>1h ${fmtUsdShort(info.volume1h)}</i>` : '';
    lines.push(`📈 Volume    ${fmtUsdShort(info.volume24h)}${v1}`);
  }

  /*
   * Buy and sell counts as a bar rather than two numbers.
   *
   * "2442 buys / 3331 sells" makes the reader do the division. The bar is the
   * answer to the question they were going to ask — which side is leaning —
   * and it reads before the digits do.
   */
  if (info.buys24h !== undefined && info.sells24h !== undefined) {
    const total = info.buys24h + info.sells24h;
    const buyShare = total > 0 ? (info.buys24h / total) * 100 : 50;
    lines.push(
      `🔁 ${pressureBar(buyShare)}  <b>${Math.round(buyShare)}%</b> buys` +
        `  <i>${fmtCount(info.buys24h)} / ${fmtCount(info.sells24h)}</i>`,
    );
  }

  // how long this has existed, which is most of the risk on a new launch
  if (info.pairCreatedAt) {
    lines.push(`🕐 Age        ${fmtAge(Date.now() - info.pairCreatedAt)}`);
  }

  /*
   * The audit, as a grid rather than a paragraph.
   *
   * These six are what somebody decides on, so they are given the shape people
   * already read them in. Two of them cannot be worked out from the token at
   * all: the share held by wallets that are really one person, and whether this
   * developer has launched and abandoned coins before. Both are how a token
   * that looks clean takes your money.
   */
  if (info.chain === 'solana') {
    const lp =
      info.lpLockedPct === undefined
        ? '⚪️ unknown'
        : info.lpLockedPct >= 99
          ? '🟢 <b>100%</b>'
          : `🔴 <b>${info.lpLockedPct.toFixed(0)}%</b>`;

    const history =
      info.creatorRugHistory === true
        ? '🚨 <b>has rugged before</b>'
        : info.creatorPriorTokens === undefined
          ? '⚪️ unknown'
          : info.creatorPriorTokens === 0
            ? '🟢 first token'
            : `${info.creatorPriorTokens > 5 ? '⚠️' : '·'} <b>${info.creatorPriorTokens}</b> launched before`;

    lines.push('');
    lines.push('<b>🔍 Audit</b>');
    if (info.holderCount !== undefined) {
      lines.push(`   👥 Holders    <b>${fmtCount(info.holderCount)}</b>`);
    }
    lines.push(`   🏆 Top 10     ${judged(info.top10Pct, limits.maxTop10Pct)}`);
    lines.push(`   🧑‍💻 Dev holds  ${judged(info.creatorHoldsPct, limits.maxDevPct, '%', 2)}`);

    /*
     * The line no reading of the token itself can produce.
     *
     * Supply spread across wallets funded from one place reads as many holders
     * and sells as one. A developer showing nothing means nothing when the
     * allocation was bundled out at creation, which is exactly the shape of the
     * screens that report "Dev 0%" next to a coin about to be dumped.
     */
    const bundled = judged(info.insiderPct, limits.maxInsiderPct);
    const wallets =
      info.insiderWallets && info.insiderWallets > 0
        ? `  <i>${info.insiderWallets} wallets, one hand</i>`
        : '';
    lines.push(`   🕸 Bundled    ${bundled}${wallets}`);
    lines.push(`   💧 LP locked  ${lp}`);
    lines.push(`   📜 Dev record ${history}`);

    // wallets, not dollars: one bot painting volume shows here as a count of 1
    if (info.traders5m !== undefined) {
      const organic =
        info.organicPct5m !== undefined && info.organicPct5m >= 20
          ? `  <i>${info.organicPct5m.toFixed(0)}% organic</i>`
          : '';
      lines.push(
        `   🧑‍🤝‍🧑 5m market  <b>${fmtCount(info.traders5m)}</b> traders` +
          (info.netBuyers5m !== undefined ? `, <b>${fmtCount(info.netBuyers5m)}</b> net buyers` : '') +
          organic,
      );
    }

    if (info.rugged) lines.push('   🚨 <b>The launch index has marked this one rugged.</b>');
  }

  // Authorities, stated either way. Silence here would read as "safe", which is
  // exactly the mistake this line exists to prevent.
  if (info.chain === 'solana') {
    const mint =
      info.mintAuthority === undefined ? '❓ unknown' : info.mintAuthority ? '⚠️ ACTIVE' : '✅ revoked';
    const freeze =
      info.freezeAuthority === undefined ? '❓ unknown' : info.freezeAuthority ? '🚨 ACTIVE' : '✅ revoked';

    /*
     * A verdict, not just the readings.
     *
     * The facts were already here and still left the reader to weigh them.
     * These are the same limits copy trading enforces, so the line answers a
     * question the operator can act on — "would the bot have bought this
     * unattended?" — rather than asking them to remember what counts as bad.
     */
    const verdict = assessToken(info, limits);
    lines.push('');
    lines.push(
      verdict.safe
        ? '<b>🛡 Safety</b>   ✅ <b>passes your limits</b>'
        : `<b>🛡 Safety</b>   🚨 <b>fails ${verdict.reasons.length} check${verdict.reasons.length === 1 ? '' : 's'}</b>`,
    );
    for (const reason of verdict.reasons.slice(0, 5)) lines.push(`   🚫 ${h(reason)}`);
    if (verdict.reasons.length > 5) lines.push(`   <i>…and ${verdict.reasons.length - 5} more</i>`);

    lines.push(`   Freeze auth  ${freeze}`);
    lines.push(`   Mint auth    ${mint}`);

    /*
     * Naming the program matters even when it carries nothing dangerous: a
     * Token-2022 mint can trap a holder with both authorities revoked, so
     * "classic SPL" and "Token-2022 with no traps" are different reassurances.
     * The traps themselves are already listed above as reasons — repeating them
     * here would say the same thing twice on the same screen.
     */
    if (info.token2022) {
      const traps = info.traps ?? [];
      lines.push(
        `   Token-2022   ${traps.length === 0 ? '✅ no transfer traps' : `🚨 ${traps.length} trap${traps.length === 1 ? '' : 's'} (above)`}`,
      );
    }
  }

  // pump.fun progress bar
  if (info.isPumpFun) {
    lines.push('');
    if (info.curveComplete) {
      lines.push('🎓 <b>Graduated</b> — trading on the AMM');
    } else if (info.curveProgressPct !== undefined) {
      lines.push('<b>🚀 pump.fun curve</b>');
      lines.push(`   ${progressBar(info.curveProgressPct)} <b>${info.curveProgressPct.toFixed(1)}%</b> to graduation`);
      if (info.curveMcapSol !== undefined) {
        lines.push(`   <i>${fmtAmount(info.curveMcapSol, 2)} SOL on the curve</i>`);
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
  if (info.holdersUnavailable && info.top10Pct === undefined) {
    lines.push('');
    lines.push('<b>👥 Top holders</b>');
    lines.push('<i>Unavailable — RPC rejected the query. Use a private endpoint.</i>');
  } else if (info.holders && info.holders.length > 0) {
    lines.push('');
    lines.push('<b>👥 Top holders</b>');

    /*
     * Concentration as a bar, with the light on it.
     *
     * The number alone asks the reader to remember what counts as high. The
     * bar shows the share of the supply ten wallets could dump at once, and
     * the light says whether that is a problem — which is the only thing the
     * figure was ever being read for.
     */
    if (info.top10Pct !== undefined) {
      const light = info.top10Pct > 50 ? '🔴' : info.top10Pct > 25 ? '🟠' : '🟢';
      lines.push(`   ${progressBar(info.top10Pct)} <b>${info.top10Pct.toFixed(1)}%</b> ${light}`);
    }

    const shown = info.holders.filter((x) => x.tag !== 'bonding curve' && x.tag !== 'pool').slice(0, 5);
    for (const [i, hold] of shown.entries()) {
      const tag = hold.tag ? ` <i>${h(hold.tag)}</i>` : '';
      const pct = hold.pctOfSupply.toFixed(2).padStart(5);
      lines.push(`   ${i + 1}. <code>${pct}%</code>  ${shortAddr(hold.owner, 4, 4)}${tag}`);
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

function progressBar(pct: number, width = 10): string {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/**
 * Buy pressure as a two-colour bar: green for the buy share, red for the rest.
 *
 * Unlike a progress bar there is no "empty" here — both halves are real, so
 * both get a colour rather than one being drawn as absence.
 */
function pressureBar(buyPct: number, width = 10): string {
  const green = Math.round((Math.min(100, Math.max(0, buyPct)) / 100) * width);
  return '🟩'.repeat(green) + '🟥'.repeat(width - green);
}

/** Coarse age: the question is "minutes or months", never "how many seconds". */
export function fmtAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'seconds';
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ${hours % 24}h`;

  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo` : `${Math.floor(months / 12)}y`;
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

  const total = summary.succeeded + summary.failed;
  if (total > 0) {
    lines.push(`${pressureBar((summary.succeeded / total) * 100)}`);
  }
  lines.push(`✅ <b>${summary.succeeded}</b> filled   ❌ <b>${summary.failed}</b> failed   ⏱ ${elapsed}`);

  /*
   * Failures first, and grouped.
   *
   * Fifty wallets doing the same thing fail the same way, so fifty identical
   * error lines is one fact printed fifty times — and it pushes the fact off
   * the screen. What the operator needs is the reason and how many hit it.
   */
  const failures = summary.results.filter((r) => !r.ok);
  if (failures.length > 0) {
    const byReason = new Map<string, string[]>();
    for (const r of failures) {
      const reason = truncate(r.error ?? 'failed', 110);
      byReason.set(reason, [...(byReason.get(reason) ?? []), r.label]);
    }

    lines.push('');
    for (const [reason, labels] of [...byReason].sort((a, b) => b[1].length - a[1].length).slice(0, 4)) {
      lines.push(`❌ <b>${labels.length}×</b> <i>${h(reason)}</i>`);
      lines.push(`   <i>${h(labels.slice(0, 4).join(', '))}${labels.length > 4 ? ` +${labels.length - 4}` : ''}</i>`);
    }
    if (byReason.size > 4) lines.push(`<i>…and ${byReason.size - 4} other reasons</i>`);
  }

  const filled = summary.results.filter((r) => r.ok && r.signature);
  if (filled.length > 0) {
    lines.push('');
    for (const r of filled.slice(0, 10)) {
      const note = r.detail ? `  ${h(r.detail)}` : '';
      lines.push(`✅ ${h(r.label)}${note}  <a href="${SOLSCAN_TX(r.signature!)}">tx ↗</a>`);
    }
    if (filled.length > 10) lines.push(`<i>…and ${filled.length - 10} more fills</i>`);
  }

  return lines.join('\n');
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

// ── settings ──────────────────────────────────────────────────────────────────

export function renderSettings(s: Settings, walletCount: number): string {
  // grouped by what they affect: how a trade fills, what it costs, what it buys
  return [
    '<b>⚙️ Settings</b>',
    '',
    '<b>Execution</b>',
    `   Mode          <b>${s.executionMode}</b>${s.executionMode === 'bundle' ? '  <i>atomic, 5 per bundle</i>' : ''}`,
    `   Slippage      <b>${s.slippagePercent}%</b>`,
    '',
    '<b>Fees</b>',
    `   Priority      <b>${s.priorityFeeSol} ◎</b>` +
      (s.priorityFeeMode === 'auto' ? `  <i>auto, max ${s.priorityFeeCeilingSol}</i>` : '  <i>fixed</i>'),
    ...(s.executionMode === 'bundle' ? [`   Jito tip      <b>${s.jitoTipSol} ◎</b>`] : []),
    `   Sweep keeps   <b>${s.sweepReserveSol} ◎</b>  <i>per wallet</i>`,
    '',
    '<b>Presets</b>',
    `   🟢 Buy        ${s.quickBuyPresets.join('  ')} ◎`,
    `   🔴 Sell       ${s.quickSellPresets.join('  ')} %`,
    '',
    '<b>Copy trade safety</b>',
    `   Top 10 max    <b>${s.copySafety.maxTop10Pct}%</b>`,
    `   Dev max       <b>${s.copySafety.maxDevPct}%</b>`,
    `   Max age       <b>${s.copySafety.maxAgeHours > 0 ? formatAge(s.copySafety.maxAgeHours) : 'any'}</b>`,
    `   1h volume     <b>${s.copySafety.minVolume1hUsd > 0 ? `min $${s.copySafety.minVolume1hUsd.toLocaleString('en-US')}` : 'any'}</b>`,
    `   Already in it <b>${s.copySafety.oneEntryPerMint ? 'skip' : 'buy anyway'}</b>`,
    `   Max per coin  <b>${s.copySafety.maxSolPerMint > 0 ? `${s.copySafety.maxSolPerMint} ◎` : 'no cap'}</b>`,
    `   Bundled max   <b>${s.copySafety.maxInsiderPct > 0 ? `${s.copySafety.maxInsiderPct}%` : 'any'}</b>`,
    `   Dev history   <b>${s.copySafety.refuseSerialRuggers ? 'refuse ruggers' : 'not checked'}</b>`,
    `   Dev factory   <b>${s.copySafety.maxDevMints > 0 ? `max ${s.copySafety.maxDevMints} mints` : 'any'}</b>`,
    `   Live market   <b>${s.copySafety.minTraders5m > 0 ? `min ${s.copySafety.minTraders5m}/5m` : 'any'}</b>`,
    '',
    `👛 <b>${walletCount}</b> wallet${walletCount === 1 ? '' : 's'}   ·   🎯 ${s.activeGroup ? h(s.activeGroup) : 'all'}`,
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
    // the limits that decide a copy buy live on the copy-trade screen, but this
    // is where people go looking for a number they want to change
    .text('🛡 Copy trade safety', 'copy_safety').primary()
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
