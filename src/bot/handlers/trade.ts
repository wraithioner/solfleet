/**
 * Public trade handler API. Implementations are grouped by the operator's task
 * so routes keep stable imports while each module owns one focused workflow.
 */
export {
  showTokenCard,
  showHolders,
  showTradeMenu,
} from './trade/token.js';

export {
  promptBuy,
  promptSell,
  promptSellEverything,
} from './trade/manual.js';

export {
  showConsolidateMenu,
  showFundMenu,
  promptFundAmount,
  promptFund,
  promptSweepSol,
  promptSweepToken,
  executeSweepToken,
} from './trade/funds.js';

export {
  showAutoSell,
  addAutoRule,
  clearAutoRules,
  promptDca,
  handleDcaSetup,
  showRulePresets,
} from './trade/automation.js';

export {
  showCopyTrade,
  promptCopyAdd,
  handleCopyAddress,
  parseCopySize,
  handleCopySize,
  describeCopySize,
  describeCopyEntries,
  describeCopyExits,
  describeCopyTakeProfit,
  describeCopyStopLoss,
  showCopyTarget,
  cycleCopyEntries,
  cycleCopyExits,
  cycleCopyTakeProfit,
  cycleCopyStopLoss,
  nextStep,
  promptCopyResize,
  handleCopyResize,
  toggleCopyTarget,
  removeCopyTarget,
} from './trade/copy.js';

export {
  showCopyDecisions,
  showCopySafety,
  cycleSafety,
  cycleStep,
} from './trade/copy-safety.js';

export { mintFromId } from '../session.js';
