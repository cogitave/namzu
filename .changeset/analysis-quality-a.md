---
'@namzu/analysis': minor
---

An answer from the index no longer claims `complete` when it is not, and several common questions are now answered correctly. Read this before upgrading: three defaults changed, and the cache is rebuilt.

**Changed defaults (this is a 0.x minor; in a 1.x package it would be a major).**

- The default ignored directories now also include `dist`, `build`, `out` and `.next`. `DEFAULT_IGNORED_DIRS` has four more entries. To keep indexing build output, pass your own `ignoreDirs` without them, or index one by path (`index` with `scope: 'dist'` walks it).
- `.gitignore` files (at the root and below it) are honoured. To keep indexing everything they list, pass `respectGitignore: false`.
- Coverage is `partial` where it used to be `complete` whenever the queried part of the tree holds ignored directories, `.gitignore`d paths, files in languages that are not parsed (`.html`, `.vue`, `.svelte`, `.es6`, …), declaration files, literals over 8,192 characters, or calls whose callee cannot be named. The reason names each with a count. Code that treated `complete` as "nothing else exists" was wrong before and is now told so.
- The cache schema is 2: the first call after upgrading rebuilds each root's index (the old cache file is left to age out).

**Answers that were wrong and are now right.**

- A search checks the files under its path against the disk before it answers, and re-reads up to 25 changed files (and 25 changed directories, 16 MiB) instead of answering "no hits" from a stale index. More than that makes the answer `partial` with the count.
- A file with a syntax error is no longer lost whole: it is read as TypeScript if it is a `.js` file with annotations, then with the broken lines set aside (offsets unchanged), and as a last resort by a scanner for strings and `function name(`. Coverage says which.
- `(0, ns.fn)()` is read as `ns.fn()`, `obj['fn']()` as `obj.fn()`; `f.call/.apply/.bind` and tagged templates are listed (`kind: 'call-via'`, `'tagged'`); `callee_unresolved` is in the evidence.
- Methods carry a `qualifiedName` (`Svc.init`, `Y.meth`, `obj.run`); `functionSource` accepts it, and `callersOf` with it lists `this.init()` inside `Svc` as `resolved` and other receivers as `text-only`.
- `enclosingFunction` and `functionSource` (new `around`) cut a long function around the position so it is inside the slice; a position in a class body outside every method is reported as such (`inClass`).
- A literal of up to 8,192 characters is kept whole, a longer one keeps both ends.
- Extension-less scripts with a `node`, `bun` or `deno` shebang are indexed. Exports cover destructuring, type-only exports, CommonJS and `export =`; `require` names are recorded. A NUL in a `findLiteral` text no longer fails.
- A call that stops says which limit it hit: after the time limit, call `index` again; after the directory limit, index a narrower path.

New dependency: `ignore` 7.0.12 (MIT).
