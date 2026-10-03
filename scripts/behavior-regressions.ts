/** Offline integration checks grouped by behavior; no source-code matching. */
import fs from 'node:fs';
import { runCopyBehaviors } from './behaviors/copy.js';
import { runWatcherBehaviors } from './behaviors/watcher.js';
import { runStorageBehaviors } from './behaviors/storage.js';
import { runTokenBehaviors } from './behaviors/token.js';
import { runUiBehaviors } from './behaviors/ui.js';
import {
  dataDir,
  vault,
  passCount,
  originalFetch,
  originalSetTimeout,
  originalNow,
} from './behaviors/fixtures.js';

try {
  vault.initVaultWithKeyfile();
  await runCopyBehaviors();
  await runWatcherBehaviors();
  await runStorageBehaviors();
  await runTokenBehaviors();
  await runUiBehaviors();
  console.log(`\n${passCount()} public-behavior regressions passed.`);
} finally {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  Date.now = originalNow;
  vault.lockVault();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
