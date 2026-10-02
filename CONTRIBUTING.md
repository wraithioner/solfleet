# Contributing

Use a supported Node.js version (CI checks Node 22 and 24), then install the locked dependencies:

```sh
npm ci
```

Before opening a pull request:

```sh
npm run format
npm run lint
npm run check
```

`npm run format` applies consistent formatting. `npm run lint:fix` applies safe lint fixes;
review the diff before committing. `npm run check` checks formatting and lint without changing
files, runs strict TypeScript checking, and runs the offline smoke and regression suites.
CI runs the same checks through `npm run check:ci`, using Biome's CI diagnostics.

Keep handlers focused on Telegram interaction and services focused on their own domain.
Reuse the shared trade-accounting functions when recording fills. Preserve wallet locking,
confirmation, cancellation, and accounting order when moving code between modules.

Test observable behavior with fake providers or controlled promises. Tests should tolerate
formatting changes and renamed local variables; avoid inspecting source-code text to establish
runtime safety. Offline checks must not submit transactions or require production credentials.

Biome is pinned so formatting and lint behavior stays reproducible. Its recommended lint rules
are enforced, with the blanket non-null assertion style rule disabled: TypeScript still uses
`strict` and `noUncheckedIndexedAccess`. Use assertions only where an existing guard or invariant
establishes the value, and keep that guard visible.
