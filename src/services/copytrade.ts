/**
 * Copy-trading public API.
 *
 * Receipt interpretation, feed recovery, entry policy and execution are kept
 * separate. Socket and poll delivery still share one durable receipt owner;
 * buys and sells still use the same authorization and serialization locks.
 */
export {
  detectTokenMoves,
  solSpent,
  isPurchase,
  MIN_SPEND_FOR_BUY_SOL,
  type TokenMove,
} from './copytrade/events.js';
export {
  copyBuySol,
  copySellPercent,
  lifetimeCostSol,
  openExposureSol,
  roomUnderCap,
} from './copytrade/policy.js';
export { armCopyRules } from './copytrade/rules.js';
export { mirrorBuy, type CopyBuyServices } from './copytrade/buy.js';
export { mirrorSell, type CopySellServices } from './copytrade/sell.js';
export { withMintLock, activeMintLocks } from './copytrade/state.js';
export {
  pollCopyTargets,
  syncSubscriptions,
  stopSubscriptions,
  liveSubscriptionCount,
  claimSignature,
  resetProcessed,
  processedCount,
  claimStats,
} from './copytrade/intake.js';
