---
"@namzu/analysis": minor
---

First release of `@namzu/analysis`, a native, paged index of JavaScript and TypeScript for agents that read code they did not write. `createCodeAnalysisProvider({ cacheDir })` returns the SDK's `CodeAnalysisProvider`: `index` (incremental by size, mtime and content hash), `findLiteral`, `enclosingFunction`, `functionSource`, `callersOf` and `imports`. Every result is paged, cited as path:line:column with UTF-16 columns, and carries what was observed, what was inferred (callers are matched by name text, not scope) and whether coverage is complete. It needs Node 22.13 or newer and installs `oxc-parser`. On Node 22.13 to 22.15 SQLite has no FTS5, so `findLiteral` scans instead of using its substring index: same answers, slower. To use it, pass the provider to `query({ codeAnalysis })` and mount `getCodeAnalysisTools(provider)` from `@namzu/sdk`.
