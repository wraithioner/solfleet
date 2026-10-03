import { getMintBalances, getMintDecimals } from '../../chains/solana.js';
import { db, type CopyTarget } from '../../store/db.js';
import { selectWallets, allWallets } from '../../store/wallets.js';
import { batchPumpTrade, measureTokensGained } from '../../trade/engine.js';
import { classifyFills, recordMeasuredBuy } from '../../trade/accounting.js';
import { errMessage, fmtAmount, escapeHtml as h } from '../../util.js';
import { config } from '../../config.js';
import { assessToken, type SafetyVerdict } from '../safety.js';
import { getTokenInfo, type TokenInfo } from '../tokeninfo.js';
import { log } from '../../logger.js';
import type { Notifier } from '../watcher.js';
import { withExecution, executionEpoch, assertExecutionEpoch } from '../execution.js';
import type { TokenMove } from './events.js';
import { copyBuySol, entriesSoFar, openExposureSol, roomUnderCap } from './policy.js';
import { currentTarget, assertCopyCurrent, copyIntent, withMintLock, noted } from './state.js';
import { armCopyRules } from './rules.js';
import { firstReason } from './reporting.js';

/**
 * Judge a token against the copy-trade limits, failing closed.
 *
 * A lookup that throws leaves every field undefined, and `assessToken` reads
 * unknown as unsafe — so a rate-limited RPC refuses the buy rather than waving
 * it through. That is the right way round: a missed entry costs nothing that
 * can be measured, and the alternative is an unattended buy into a token
 * nothing could be read about.
 */
async function screenToken(mint: string): Promise<{ verdict: SafetyVerdict; info?: TokenInfo }> {
  const limits = db.settings().copySafety;
  try {
    // a copied entry is a race; the card path can afford to wait, this cannot
    const info = await getTokenInfo(mint, 'solana', { fast: true });
    return { verdict: assessToken(info, limits), info };
  } catch (err) {
    return {
      verdict: {
        safe: false,
        reasons: [`Could not read the token to check it: ${errMessage(err)}`],
        notes: [],
      },
    };
  }
}
/**
 * Which trader has already been told its copy size cannot fit under the cap.
 *
 * Keyed by target, valued by the two numbers that were wrong, so raising the
 * cap or resizing the trader gets a fresh warning if it is still wrong, and
 * nothing repeats while it stands. Held in memory on purpose: a restart is
 * cheap to re-warn after, and the alternative is another migrated field.
 */
const capWarnings = new Map<string, string>();
export interface CopyBuyServices {
  selectWallets: typeof selectWallets;
  getMintBalances: typeof getMintBalances;
  allWallets?: typeof allWallets;
  getMintDecimals?: typeof getMintDecimals;
  screenToken: typeof screenToken;
  batchPumpTrade: typeof batchPumpTrade;
  measureTokensGained: typeof measureTokensGained;
}

const buyServices: CopyBuyServices = {
  selectWallets,
  getMintBalances,
  allWallets,
  getMintDecimals,
  screenToken,
  batchPumpTrade,
  measureTokensGained,
};

export async function mirrorBuy(
  target: CopyTarget,
  move: TokenMove,
  theirSol: number,
  notify: Notifier,
  services: CopyBuyServices = buyServices,
): Promise<void> {
  const epoch = executionEpoch();
  const intent = copyIntent(target);
  // every decision below reads state that a concurrent copy would change
  return withExecution(
    () => {
      assertExecutionEpoch(epoch);
      return withMintLock(move.mint, () =>
        mirrorBuyLocked(target, move, theirSol, notify, services),
      );
    },
    () => {
      const current = currentTarget(target);
      return !!current && copyIntent(current) === intent;
    },
  );
}

async function mirrorBuyLocked(
  target: CopyTarget,
  move: TokenMove,
  theirSol: number,
  notify: Notifier,
  services: CopyBuyServices,
): Promise<void> {
  assertCopyCurrent(target);
  // a token this target was already refused is not reconsidered: the answer
  // will not have changed, and re-reading it turns one bad coin into a stream
  if (target.refusedMints?.includes(move.mint)) {
    noted(target, move.mint, 'Already refused by the safety checks — not reconsidered');
    return;
  }

  const already = entriesSoFar(target, move.mint);

  /*
   * How far to follow a trader averaging in. On `first` their opening buy is
   * the signal and the rest is noise; on `every` we average in with them, up to
   * a cap — without one, how much of the operator's money goes into a token
   * would be decided entirely by how many times somebody else clicks buy.
   */
  const allowed = target.entryMode === 'every' ? Math.max(1, target.maxEntries) : 1;
  if (already >= allowed) {
    if (already === allowed && target.entryMode === 'every') {
      log.info(`Copy cap reached for ${move.mint} from ${target.label} (${allowed} entries).`);
      noted(
        target,
        move.mint,
        `Already taken ${allowed} entr${allowed === 1 ? 'y' : 'ies'} from them in this coin`,
      );
    }
    return;
  }

  const wallets = services.selectWallets();
  if (wallets.length === 0) return;

  const perWallet = copyBuySol(target, theirSol, wallets.length, config.safety.maxBuySolPerWallet);
  if (perWallet <= 0) {
    log.warn(`Skipped copying ${target.label} into ${move.mint}: computed size was zero.`);
    noted(target, move.mint, 'Their trade was too small to mirror at your sizing');
    return;
  }

  /*
   * How much of this one coin the operator ends up holding.
   *
   * The entry cap above is stored on the followed wallet, so it bounds how
   * often THIS trader can pull you into a token and nothing else. Follow three
   * wallets that all buy the same coin and you take three full-size entries,
   * because none of the three records can see the other two. This is the only
   * check that sees the position rather than the follower.
   *
   * The batch is refused whole rather than trimmed to fit. A size the operator
   * did not choose is worse than a skip they can read: the message says what is
   * already in, what this would have added, and where the limit is.
   */
  const limits = db.settings().copySafety;

  /*
   * What the wallets hold of this coin right now.
   *
   * Read here rather than just before the trade — it is the same call either
   * way, and both limits below are about the position rather than the history.
   */
  /*
   * Start the screening while the balances are being read.
   *
   * Both are network round trips and neither needs the other's answer. Run in
   * sequence they are two waits on the critical path of a raced entry; started
   * together they cost the longer of the two. The screen is what the decision
   * hangs on, so it is the one to get moving first.
   *
   * A screen begun for a buy the limits then refuse is a wasted request, not a
   * wasted trade — and refusals are the exception, so the trade is made against
   * the common case.
   *
   * It is given a catch at the point it is created rather than where it is
   * awaited, because the checks below can return before anything awaits it.
   * An unhandled rejection ends the process on this runtime, which would turn
   * a token that could not be read into the whole bot going down.
   */
  const screening = services
    .screenToken(move.mint)
    .catch((err: unknown): { verdict: SafetyVerdict; info?: TokenInfo } => ({
      verdict: {
        safe: false,
        reasons: [`Could not read the token to check it: ${errMessage(err)}`],
        notes: [],
      },
    }));

  const accountAddresses = [
    ...new Set([...wallets, ...(services.allWallets?.() ?? [])].map(w => w.address)),
  ];
  const heldBefore = await services
    .getMintBalances(accountAddresses, move.mint)
    .catch(() => undefined);
  assertCopyCurrent(target);
  if (heldBefore === undefined) {
    // Unknown holdings cannot establish room under either position limit, and
    // must not reset the cost basis as though this were an empty position.
    log.warn(`Skipped copying ${target.label} into ${move.mint}: holdings could not be read.`);
    noted(
      target,
      move.mint,
      'Your token balances could not be read — exposure limits cannot be checked',
    );
    return;
  }
  const holding = [...heldBefore.values()].some(v => v > 0n);
  const openSol = openExposureSol(move.mint, holding);

  /*
   * Somebody else already put you in this coin.
   *
   * Two followed wallets liking the same token is not two reasons to own it.
   * The second copy lands later, so it pays a worse price for the same bet, and
   * it doubles what a rug takes out — the conviction being mirrored is one
   * trade's worth however many people made it.
   *
   * Scoped to a coin this target did not open, so a trader set to average in
   * still can. What it refuses is a stranger joining a position already on the
   * books, whether the bot opened it copying somebody else or the operator
   * bought it by hand.
   */
  if (limits.oneEntryPerMint && !target.copiedMints.includes(move.mint) && holding) {
    log.info(
      `Skipped copying ${target.label} into ${move.mint}: ` +
        `already holding ${openSol.toFixed(4)} SOL of it.`,
    );
    noted(target, move.mint, `You already hold ${openSol.toFixed(3)} ◎ of this coin`);
    return;
  }

  const room = roomUnderCap(move.mint, limits.maxSolPerMint, holding);
  const batchSol = perWallet * wallets.length;

  if (batchSol > room) {
    log.warn(
      `Skipped copying ${target.label} into ${move.mint}: ` +
        `${openSol.toFixed(4)} SOL already in, this adds ${batchSol.toFixed(4)}, ` +
        `cap is ${limits.maxSolPerMint} SOL.`,
    );
    noted(
      target,
      move.mint,
      openSol > 0
        ? `Would put ${(openSol + batchSol).toFixed(3)} ◎ in one coin, over your ${limits.maxSolPerMint} ◎ cap`
        : `Copy size ${batchSol.toFixed(3)} ◎ is over your ${limits.maxSolPerMint} ◎ per-coin cap`,
    );

    /*
     * One case here is not a skip, it is a misconfiguration.
     *
     * When a fixed size is larger than the whole cap, no position and no coin
     * makes it fit — every copy from this wallet will be refused for as long
     * as the two numbers stand. That reads from Telegram as copy trading
     * simply not working, so it is worth one message, said once per pair of
     * numbers rather than once per coin.
     *
     * Fixed sizing only, and that is the whole point of the check. Under
     * percent sizing the batch is a share of THEIR trade, so a size over the
     * cap says they made one big buy, not that anything is set up wrong — the
     * next smaller trade fits. Warning on that would fire on a new amount
     * every time, which is the stream of noise this change exists to remove.
     */
    if (target.sizeMode !== 'percent' && batchSol > limits.maxSolPerMint) {
      const signature = `${batchSol.toFixed(4)}/${limits.maxSolPerMint}`;
      if (capWarnings.get(target.id) !== signature) {
        capWarnings.set(target.id, signature);
        await notify(
          [
            '⚠️ <b>Copy trading is sized above your per-coin cap</b>',
            '',
            `<b>${h(target.label)}</b> copies at <b>${batchSol.toFixed(4)} ◎</b> a coin ` +
              `(${perWallet.toFixed(4)} ◎ × ${wallets.length} wallet${wallets.length === 1 ? '' : 's'}), ` +
              `and the cap is <b>${limits.maxSolPerMint} ◎</b>.`,
            '',
            'Nothing from this trader can be copied until one of those two changes.',
            '',
            '<i>Copy trading → Safety → Per token, or lower the size on this trader.</i>',
          ].join('\n'),
        ).catch(() => {});
      }
    }
    return;
  }

  /*
   * Claim the slot BEFORE the screening call, not after.
   *
   * `screenToken` is a network round trip, and two of this target's own
   * transactions arriving close together — one down the socket, one from the
   * reconciling poll, which calls in outside the socket's serial queue — could
   * both read the same entry count while the other was suspended inside it, and
   * both go on to spend. The mint lock closes that window for good, and writing
   * the claim first means even a lock that failed cannot produce a double buy.
   */
  db.updateCopyTarget(target.id, {
    entryCounts: { ...(target.entryCounts ?? {}), [move.mint]: already + 1 },
  });
  target.entryCounts = { ...(target.entryCounts ?? {}), [move.mint]: already + 1 };

  /*
   * Read the token before buying it.
   *
   * The trader being followed may be the deployer, may be exit liquidity, or
   * may simply be wrong. Nothing about their buy says the token can be sold
   * again, and this is the only buy in the bot that nobody looks at first.
   *
   * The entry is claimed either way. A token refused once should not be
   * reconsidered on their next buy into it — the answer will not have changed,
   * and re-reading it every time turns one bad token into a stream of alerts.
   */
  const { verdict, info } = await screening;
  assertCopyCurrent(target);
  if (!verdict.safe) {
    /*
     * Recorded as refused, not as copied. Those were once the same list, which
     * meant a coin the gate had rejected — nothing bought, no money spent —
     * still counted as a position this target was entitled to sell out of.
     */
    db.updateCopyTarget(target.id, {
      refusedMints: (target.refusedMints ?? []).includes(move.mint)
        ? target.refusedMints
        : [...(target.refusedMints ?? []), move.mint],
      entryCounts: { ...(target.entryCounts ?? {}), [move.mint]: allowed },
    });

    log.warn(`Refused to copy ${target.label} into ${move.mint}: ${verdict.reasons.join(' ')}`);
    noted(target, move.mint, verdict.reasons[0] ?? 'Failed the safety checks', info?.symbol);
    return;
  }

  /*
   * Now it counts as copied. The slot was claimed before the screening call;
   * this list means something narrower and is written only here — the wallets
   * are about to hold this coin because of this trader, which is the fact the
   * exit path needs and the only one that should let their sell move it.
   */
  db.updateCopyTarget(target.id, {
    copiedMints: target.copiedMints.includes(move.mint)
      ? target.copiedMints
      : [...target.copiedMints, move.mint],
  });
  if (!target.copiedMints.includes(move.mint)) target.copiedMints.push(move.mint);

  const settings = db.settings();
  log.info(`Copying ${target.label} into ${move.mint} (entry ${already + 1}/${allowed})`);

  const sizing =
    target.sizeMode === 'percent'
      ? `${target.sizePercent}% of their ${fmtAmount(theirSol, 3)} SOL`
      : `${target.buySol} SOL each`;

  await notify(
    [
      `👥 <b>${h(target.label)} bought</b>`,
      `<code>${move.mint}</code>`,
      '',
      `Entry ${already + 1}/${allowed} · ${sizing}`,
      `Mirroring ${fmtAmount(perWallet, 4)} SOL × ${wallets.length} wallets…`,
    ].join('\n'),
  ).catch(() => {});

  try {
    assertCopyCurrent(target);
    const summary = await services.batchPumpTrade(wallets, {
      action: 'buy',
      mint: move.mint,
      amount: perWallet,
      denominatedInSol: true,
      slippagePercent: settings.slippagePercent,
      priorityFeeSol: settings.priorityFeeSol,
      pool: 'auto',
    });

    const { fills, uncertain } = classifyFills(summary);
    if (uncertain) db.invalidateBasis(move.mint);

    // the token count is the cost basis: without it there is no entry price,
    // and without an entry price a take-profit or stop-loss cannot fire at all
    const decimals =
      info?.decimals ?? (await services.getMintDecimals?.(move.mint).catch(() => undefined));
    await recordMeasuredBuy(
      {
        mint: move.mint,
        summary,
        solPerWallet: perWallet,
        before: heldBefore,
        decimals,
        symbol: info?.symbol,
      },
      { ledger: db, measureTokensGained: services.measureTokensGained },
    );

    if (fills > 0) armCopyRules(target, move.mint, notify);
    db.appendTradeLog({
      at: Date.now(),
      action: `copy buy ${fmtAmount(perWallet, 4)} SOL`,
      mint: move.mint,
      walletCount: wallets.length,
      succeeded: summary.succeeded,
      failed: summary.failed,
      note: `copied ${target.label} (entry ${already + 1}/${allowed})`,
    });

    await notify(
      `👥 Copy buy done — ✅ ${summary.succeeded}  ❌ ${summary.failed}${firstReason(summary)}` +
        (uncertain
          ? '\nSome trades may still land. Entry basis is unknown; check the wallets before another order.'
          : ''),
    ).catch(() => {});
  } catch (err) {
    await notify(`❌ Copy buy failed: <i>${errMessage(err)}</i>`).catch(() => {});
  }
}
