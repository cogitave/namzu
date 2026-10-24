---
"@namzu/sdk": patch
---

The published file list is unchanged: the tarball holds the same 4321 files as before, and every target of the `exports` map (`./dist/index.js`, `./dist/index.d.ts`, `./dist/testing.js`, `./dist/testing.d.ts`) is still in it. Nothing a consumer imports was removed, and nothing needs to change on your side. Only how `files` in `package.json` selects them changed, from "the whole `dist` and `src` minus test globs" to a list by extension that skips test files, which makes `pnpm pack` and `pnpm publish` of this package take about 4 seconds instead of about 90.
