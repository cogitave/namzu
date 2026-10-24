# @namzu/analysis

## 0.2.1

### Patch Changes

- 0cb1c5d: Fix `findLiteral` and `findCallers` failing with "file N is not in the index" while another process was indexing the same root into the same cache. Every indexer replaced the rows of files that another indexer had just stored from identical bytes, which re-issued their ids under any reader in the middle of a query, and a reader that lost the race five times in a row gave up. An indexer now keeps rows that already match the file it parsed, and these queries read their hits and the files behind them from one consistent view of the cache. No API change; nothing to do on upgrade.

## 0.2.0

### Minor Changes

- 9521ea8: An answer from the index no longer claims `complete` when it is not, and several common questions are now answered correctly. Read this before upgrading: three defaults changed, and the cache is rebuilt.

  **Changed defaults (this is a 0.x minor; in a 1.x package it would be a major).**

  - The default ignored directories now also include `dist`, `build`, `out` and `.next`. `DEFAULT_IGNORED_DIRS` has four more entries. `dist`, `build` and `out` are skipped by default only beside a `package.json` or when a `.gitignore` lists them (a `src/build/` of source is indexed); a list you pass as `ignoreDirs` is taken as written. To keep indexing build output, pass your own `ignoreDirs` without them, or index one by path (`index` with `scope: 'dist'` walks it).
  - `.gitignore` files (at the root and below it) are honoured. To keep indexing everything they list, pass `respectGitignore: false`.
  - Coverage is `partial` where it used to be `complete` when something that could hold the answer was not searched: a `.gitignore`d source file, an unparsed `.html`/`.vue`/`.svelte`/`.es6`/`.coffee` file in scope, a degraded or crashed file in scope, a literal over 8,192 characters cut (for a needle longer than one character), and, for `callers_of`, calls through a computed callee when no static call was found or when they are 5 % or more of the calls in scope. Vendored and build directories, `.gitignore`d directories and declaration files are stated in `observed` and leave coverage alone. Single-file operations (`enclosingFunction`, `functionSource`, `imports`) depend only on their own file. Code that treated `complete` as "nothing else exists" was wrong before and is now told so. `callee_unresolved: N` in `observed` became "N of M calls in scope use a computed callee".
  - The cache schema is 3: the first call after upgrading rebuilds each root's index (the old cache file is left to age out).

  **Answers that were wrong and are now right.**

  - A search checks the files under its path against the disk before it answers, and re-reads up to 25 changed files (and 25 changed directories, 16 MiB) instead of answering "no hits" from a stale index. More than that makes the answer `partial` with the count.
  - A file with a syntax error is no longer lost whole: it is read as TypeScript if it is a `.js` file with annotations, then with the broken lines set aside (offsets unchanged), and as a last resort by a scanner for strings and `function name(`. Coverage says which.
  - `(0, ns.fn)()` is read as `ns.fn()`, `obj['fn']()` as `obj.fn()`; `f.call/.apply/.bind` and tagged templates are listed (`kind: 'call-via'`, `'tagged'`); `callee_unresolved` is in the evidence.
  - Methods carry a `qualifiedName` (`Svc.init`, `Y.meth`, `obj.run`); `functionSource` accepts it, and `callersOf` with it lists `this.init()` inside `Svc` as `resolved` and other receivers as `text-only`.
  - `enclosingFunction` and `functionSource` (new `around`) cut a long function around the position so it is inside the slice; a position in a class body outside every method is reported as such (`inClass`).
  - A literal of up to 8,192 characters is kept whole, a longer one keeps both ends; the cut is marked with control characters only, so a search for `…` no longer matches it, and a search text holding U+0001 or U+0002 is refused with a plain error.
  - `this.#p()` is read as `this.#p`, so `callersOf('A.#p')` finds it and never the public `p`.
  - A new extension-less shebang script named as the path is found on the first query; a changed directory refreshes only its own entries (adding a file at the top of a 16,000-file tree went from 1.1 s to 70 ms); the directory time is read before its listing; a `.gitignore` rule that cannot be compiled is dropped instead of failing the query, and a `.gitignore` that is a symbolic link is not read.
  - Extension-less scripts with a `node`, `bun` or `deno` shebang are indexed. Exports cover destructuring, type-only exports, CommonJS and `export =`; `require` names are recorded. A NUL in a `findLiteral` text no longer fails.
  - A call that stops says which limit it hit: after the time limit, call `index` again; after the directory limit, index a narrower path.

  New dependency: `ignore` 7.0.12 (MIT).

## 0.1.0

### Minor Changes

- 1fde185: First release of `@namzu/analysis`, a native, paged index of JavaScript and TypeScript for agents that read code they did not write. `createCodeAnalysisProvider({ cacheDir })` returns the SDK's `CodeAnalysisProvider`: `index` (incremental by size, mtime and content hash), `findLiteral`, `enclosingFunction`, `functionSource`, `callersOf` and `imports`. Every result is paged, cited as path:line:column with UTF-16 columns (a byte-order mark counts as the first character, as in what `read` shows), and carries what was observed, what was inferred (callers are matched by name text, not scope) and whether coverage is complete. It parses in a child process, so a parser crash on a pathological file (a 6,000-deep array, 100,000 chained terms) costs that file and is reported as partial coverage rather than ending your process; it stops at 20,000 directories or 45 seconds per call and says which narrower path to index next; it never reads through a link or outside its root, even for a file replaced after indexing; and several processes can index one root at once. A host that bundles the package names its own copy of the parsing child with the `hostScript` option, or builds the `@namzu/analysis/indexer-host` export as an entry. Its parsing child gets no environment secrets, runs under Node's permission model, and starts outside the project. On Linux, where `/proc` allows it, a crash dumps only the child's headers, not its memory. The cache is trimmed by age and size. It needs Node 22.13 or newer and installs `oxc-parser`. On Node 22.13 to 22.15 SQLite has no FTS5, so `findLiteral` scans instead of using its substring index: same answers, slower, in a separate cache file. To use it, pass the provider to `query({ codeAnalysis })` and mount `getCodeAnalysisTools(provider)` from `@namzu/sdk`.
