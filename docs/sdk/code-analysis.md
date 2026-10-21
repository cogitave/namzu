---
type: Reference
title: Code analysis
description: The code_analysis tool and the CodeAnalysisProvider it calls, a paged, cited index of JavaScript and TypeScript for finding a string, the function around it, its source and its callers, and the @namzu/analysis package that implements it.
resource: packages/sdk/src/tools/builtins/code-analysis.ts
tags: [sdk, analysis, tools, code-index, evidence]
status: stable
generated: { by: claude-code/sonnet-5.5, at: 2026-10-21T00:00:00Z }
---

# Code analysis

`grep` finds a string and says nothing of the function around it. A language server ([`lsp`](../../packages/lsp/README.md)) resolves symbols the project's own types can see, and has nothing to say about a 40 MB bundle with no types and a hundred one-letter names. `code_analysis` is for that case: *which function holds this string, what is its exact source, and who calls it by name*, over code nobody wrote for you to read.

The split is the one `lsp` uses. `@namzu/sdk` declares the interface (`CodeAnalysisProvider`) and the tool; `@namzu/analysis` implements the interface with a parser and a SQLite store. The dependency points one way: `sdk ← analysis`.

## Offering the tool

The tool is not in `getBuiltinTools()` and is registered only when a host has a provider, because a tool that is always present and always answers "unavailable" costs a decision on every turn to say nothing. The provider rides on the turn: `QueryParams.codeAnalysis` becomes `ToolContext.codeAnalysis`.

```ts
import { createCodeAnalysisProvider } from '@namzu/analysis'
import { getCodeAnalysisTools, toolset } from '@namzu/sdk'

const codeAnalysis = createCodeAnalysisProvider({ cacheDir: '/var/cache/my-agent/analysis' })

// The roster entry, and the provider to pass to `query({ ..., codeAnalysis })`.
export const tools = toolset('code-analysis', getCodeAnalysisTools(codeAnalysis))
export const provider = codeAnalysis
```

A turn that runs in a sandbox is refused by the tool: the index reads the host file system, and a sandbox's workspace is not that one.

The schema is about 3,900 characters (roughly 1,000 tokens) on every request that carries it. Mount it with `deferred(...)` and a request that never needs it carries a one-line hint and `search_tools` instead, about 1,050 characters; the terminal does this. The first sentence of the description is that hint, so it is written to name both reasons to reach for the tool (minified bundles, and finding the function around a string).

## Operations

One tool, one `operation` union, like `lsp`. Every operation takes a path through the same resolver and the same review route as `read` (see [Paths](#paths)).

| Operation | Input | Answers |
|---|---|---|
| `index` | `path?`, `force?` | Builds or refreshes the index. Incremental by size, mtime and content hash. |
| `find_literal` | `text`, `path?`, `case_sensitive?`, paging | Each string or template literal containing `text`: file, line, column, and the innermost function around it. |
| `enclosing_function` | `path`, `line`, `column?`, `max_chars?` | The function containing a position: exact source, line range, parent chain. |
| `function_source` | `function_id` or `path` + `name` (`name` or `Class.method`), `line?`, `column?`, `max_chars?`, paging | A function's exact source. With `line` (and `column`), a function longer than `max_chars` is cut around that position. |
| `callers_of` | `name` (`foo`, `obj.foo`, `this.foo` or `Class.method`), `scope?`, `path?`, `match?`, paging | Call sites of a name, each with its enclosing function. |
| `imports` | `path`, paging | One file's imports and exports. |

All operations except `index` build the part of the index they need on first use and say so in `observed`. Call `index` to refresh after files changed, or with a narrower `path` to cover one part of a root at a time (see [Large roots](#large-roots)).

Every call takes the turn's abort signal. Cancelling an index abandons it and kills the parsing child; what it had already committed stays, so the next call continues from there. A call still queued behind another never starts.

### Positions

Lines and columns are **one-based**. Columns count **UTF-16 code units**, which is what a JavaScript string index is, so a character outside the Basic Multilingual Plane takes two. `start` and `end` are the same UTF-16 offsets into the file, half-open. A line ends at `\n`. A column past the end of its line is refused rather than clamped, because on a minified file a miscounted column would otherwise return the function around the wrong place with a citation that looks right.

A method's range is the method (`static async load(id) { ... }`), not the inner function expression the parser reports, which starts at the parameter list. Getters, setters, constructors, object methods and arrows assigned to properties are functions with their own ranges and names.

### Paging

Every list takes `limit` (default 50, at most 200) and `cursor`, and returns `total` for all pages. The cursor is opaque. It is bound to its query and to the index state it was cut from: replaying it on another query, or after the index changed, is an error that says to repeat the query without it, never a page from the wrong place.

### Staleness

The index is a snapshot, and a snapshot can only be trusted about what it contains. A search that returns nothing is the answer an editing agent acts on ("no caller, delete it"), so a query does not trust the snapshot about its own scope: before `find_literal` or a workspace `callers_of` answers, it compares what is recorded under the queried path with the disk, by `lstat` and no read: the size and mtime of every indexed file, and the mtime of every directory the index walked (an entry added, removed or renamed in a directory moves its mtime). A file that is new and named by the query is checked too (a source file, or an extension-less script with a node, bun or deno shebang). A changed directory refreshes only its own entries: a subdirectory that is recorded has a row and a check of its own, a new one is walked, and a removed one takes its rows with it. Adding one file at the top of a 16,000-file tree therefore costs about as much as the unchanged check (70 ms, from 1,109 ms when the whole tree below was walked again). A directory's mtime is read before its listing, so an entry created while the walk is listing it is seen as a change by the next query. For a tree of a few thousand files that costs about 10 ms per query (2,434 files: 11 ms), and the event loop is given a turn every 4 ms.

What it does with a difference is one rule:

> When at most **25 files** and **25 directories** differ, and the changed files total at most **16 MiB**, they are re-indexed before the query runs, and `observed` says so ("3 file(s) and 1 directory had changed since the index was built and were re-read before this answer"). Otherwise nothing is re-read and coverage is `partial`, naming how many files changed (`30 file(s) changed since indexing (…); too many to re-read for one query. Run the index operation to refresh`).

The first half keeps an answer right after an edit; the second keeps a query from becoming a surprise full index after a `git checkout` that rewrote thousands of files, which is the `index` operation's job. A hit whose file changed after the check, or that is still stale because it was too many to re-read, carries `stale: 'changed'` (its position may be off), one whose file was deleted carries `stale: 'deleted'`, and coverage says how many. One edit is still invisible: a rewrite that keeps both the size and the mtime to the sub-millisecond (a content hash catches it on any read of the file, `index --force` anywhere). A BOM is kept in the text, so a column on line 1 is a position in exactly the string `read` shows.

### Source slices

`enclosing_function` and `function_source` cut the function's source from the file and check it against the content hash recorded at index time. A file that changed is re-indexed first (or, for `function_source` by id, the call fails and says so, because ids are re-issued when a file is re-read). Slices are capped by `max_chars` (default 20,000, at most 200,000). A cut is reported (`cut: showing N of M characters`), never silent, and never lands inside a surrogate pair.

When the function is longer than the cap, `enclosing_function` does not return the first `max_chars` characters: it returns the function's header (its first quarter of the cap, at most 400 characters), a marker for what was left out, and the characters around the position asked about, so the cited position is always inside the slice (`source.window` gives the file offsets). In a bundle, 2.3 % of literals sit past the first 20,000 characters of their function, and those were exactly the ones the head cut lost. `function_source` does the same when it is given `line` (and `column`); without a position it still cuts at the end. A position in a class body outside every method (a field initializer, a `static {}` block) is answered as `in the body of class Svc`, not as the top level of the file.

## Evidence

Every successful result carries three things beside the answer:

- `observed`: what the index read out of the files, as fact. For `callers_of` it states how many calls in scope use a computed callee ("2 of 4 calls in scope use a computed callee": a computed key, the result of an expression), and every operation states what the walk left out that cannot hide an answer (below).
- `inferred`: what was concluded rather than read. The index does no scope analysis, so a callee matched by text is an inference, and the evidence says so. A call through an alias or a destructured binding, or through a computed key that is not a string literal, is not matched, and the evidence says that too.
- `coverage`: `complete`, or `partial` with reasons. **`complete` means nothing that could hold the answer was left out**, so a search that found nothing in the part of the tree it looked at does not read as a search of the tree. The rule is exact, and it is per operation.

  **Left out, and cannot hide an answer: a note in `observed`, coverage unchanged.** Directories that are never source (`node_modules`, `.git`, `.hg`, `.svn`, `.namzu`); the default build output (`.turbo`, `.cache`, `coverage`, `.next`, and `dist`, `build`, `out` when a `package.json` sits beside them or a `.gitignore` lists them; a `src/build/` with neither is source and is indexed); declaration files (`.d.ts`, types only); directories a `.gitignore` lists. Each is named with a count (`dist ×17, coverage ×1`), and naming one as the path indexes it.

  **`find_literal` is `partial` only when** (a) a file that is likely to hold JavaScript but is not parsed is in scope (`.html .htm .vue .svelte .astro .es .es5 .es6 .jsm .coffee`, counted per extension); (b) literals in scope were cut (over 8,192 characters, they keep their first and last 4,096) and the needle is longer than one character; (c) a file in scope is degraded (read after setting broken lines aside, or by a tolerant scan) or crashed the parser; (d) more files changed than the 25 a query re-reads; (e) a time or directory limit stopped an index of the scope. Also partial: a source *file* a `.gitignore` lists, a directory the caller put in `ignoreDirs` that is not a default one, files skipped as binary or too large, and a root of which only part is indexed.

  **`callers_of`** has the same rule plus the computed callees, which are always counted in `observed` and make the answer `partial` only when no static call to the name was found and at least one call in scope is computed ("no static call to \"x\" found; 1 call(s) in scope use a computed callee and could reach it"), or when computed callees are 5 % or more of the calls in scope. With the file scope only that file's own parse state and the computed callees count.

  **`enclosing_function`, `function_source` and `imports`** are about one file, so only that file's own parse state matters: a degraded or crashed file is `partial`, and nothing about the rest of the tree is.

  The degraded, crashed and link-swapped lookups are scoped by the query's path, not global: a bad file in `bad/` does not make a question about `good/` partial. A Flow file that parsed cleanly as TypeScript has no syntax errors to report.

  Other `partial` reasons: hits from files that changed on disk, and files with syntax errors, with how they were read (below).

### Syntax errors

For some errors the parser returns a recovered tree. For others it returns an empty program, which used to lose the whole file. The index now reads such a file in three steps and reports it as having had syntax errors, except when the first step parses it cleanly: a `.js` file is tried as TypeScript (Flow annotations, with the `// @flow` pragma, which the parser refuses outright, set aside), and a clean parse there is simply a file that parsed; then the lines the parser points at are blanked in place and the file is parsed again, up to 12 times and while under half the text is blanked (the blanked text has the same length and line breaks, so every offset and line number is the real file's, and the functions on either side of a bad statement are kept); and as a last resort a tolerant scanner finds strings and `function name(` anchors only. The coverage reason says which: "read after setting the broken lines aside", or "degraded to a tolerant scan that finds strings and function declarations only, with no calls, methods or imports".

### Names and callers

A function's `name` is its own, or what it is assigned to. A method is also given a `qualifiedName`: `Svc.init` for a method of the class `Svc` (a class expression assigned to a variable takes the variable's name: `var Y = class extends Z { meth() {} }` is `Y.meth`), `obj.run` for a method or function property of an object literal assigned to `obj`, `module.exports.go` for one in `module.exports = { go() {} }`. `function_source` accepts either spelling, so the 18 % of named functions in a bundle that collide on a bare name can be asked for apart.

`callers_of` reads the callee text after normalising the shapes a compiler wraps a call in: `(0, ns.helper)()` is `ns.helper()`, and `obj['name']()` is `obj.name()`; `this.#p()` is `this.#p`, a private method's name keeps its `#`, so `callers_of` for `A.#p` never lists the public `p`. `f.call(…)`, `f.apply(…)` and `f.bind(…)` are also listed as a use of `f` with `kind: 'call-via'`, and a tagged template as `kind: 'tagged'` against its tag.

A qualified name that the index declares (`Svc.init`) asks for a method. The answer lists `this.init()` inside `Svc` first, with `resolution: 'resolved'`, and then every other `<expression>.init()` with `resolution: 'text-only'`: the receiver's type is not known, and it may be another class's `init` or a subclass's. Against the type checker on `packages/sdk/src` (60 methods, 272 true callers), the resolved calls had precision 0.97 and recall 0.56, and all matches together had recall 1.00 at precision 0.08. A bare method name with the default `exact` match still finds nothing (a method is never called as a bare name); `match: 'member'` finds every `.name`. Scope analysis, which would separate the text-only calls, is not in the index.

### Output

The tool prints a page compactly: paths relative to the root and printed once per file, a function as `Svc.init#12 L10-40` (name, id, line range; kind and path only on the single-function answers), and the argument count of a call, with `[text-only]`, `[call/apply/bind]` and `[tagged template]` where they apply. Fifty `find_literal` hits on a 2,434-file bundle went from 20,246 characters (about 5.6k tokens) to 3,568 (about 1k), and 200 hits from 79,752 to 15,999. The structured `data` the tool returns beside the text still carries absolute paths and every field. The text format of this tool changed with it (the compact form replaced the earlier one-line-per-hit listing with absolute paths). When the turn has more than one root, a first line says which one the relative paths are relative to (`paths are relative to /work/app`).

## The three answers

As with `CodeNavigationResult`, a query ends in one of three cases and they are not interchangeable:

- `ok` with an empty page: "I looked and there are none". It is the answer a deletion depends on.
- `unsupported`: this provider cannot do that. The tool points at `grep` and says the fallback is textual.
- `failed`: something broke. The tool says the answer is unknown rather than empty.

## Paths

Every operation resolves its `path` with `resolveWithinAnyReal(toolRoots(context), path)`, the resolver `read` and `grep` use, and the tool declares `pathArgument: 'path'`, so a host that reviews paths outside the session's directories (`outsideRootAccess: 'review'`) asks before the call runs. There is no second way past the boundary:

- The index is built over the session directory that contains the resolved path, never over a path the model passed to the provider directly.
- A file reached only because a review approved that one file is not widened to its directory. The tool refuses it and says to add the directory.
- Symbolic links are never followed by the indexer, so a link inside a root cannot lead the walk out of it.
- The boundary holds after indexing too. Every read of an indexed file goes through one function that refuses anything that is not a regular file by `lstat`, opens without following a final link, opens non-blocking so a pipe swapped in cannot stall a thread, and then asks the open descriptor where it is: on Linux `readlink(/proc/self/fd/N)` must be inside the root (elsewhere the descriptor's device and inode must equal those of the canonical path, which must be inside). `O_NOFOLLOW` covers only the last path component; flipping a middle component between an inside and an outside link was measured to win about once in 80,000 reads against path-based checks alone, and the descriptor check closes that. The canonical path is checked again after the read. A file replaced by a link, or under a directory swapped for one, is dropped from the index without being read and named in coverage. This applies to id lookups and to a `find_literal` or `callers_of` with no path as much as to a call that names a file.

## `@namzu/analysis`

`createCodeAnalysisProvider(options)` returns the provider. Options: `cacheDir`, `ignoreDirs`, `respectGitignore`, `maxFileBytes`, `maxFiles`, `maxDirectories`, `maxMillis`, `hostScript`, `parserModule`, `cacheMaxAgeDays`, `cacheMaxBytes`, `substringIndex`.

- **Parser**: `oxc-parser`, pinned, in a child process (this package's `dist/indexer-host.js`, or the `hostScript` a bundling host names; the module is also exported as `@namzu/analysis/indexer-host` for a host to build as its own entry). On a handful of pathological inputs (a 6,000-deep array, 20,000 chained ternaries, 100,000 `+` terms, 100,000 nested calls, all measured on 0.155.0) it dies with SIGSEGV, which a worker thread does not isolate. Which of those inputs crash differs between machines: all four on a development machine, one on a GitHub runner. The child names the file it is on; if it dies the parent records that file with no rows, reports `parser crashed` in coverage, starts a new child and carries on. A child the host kills on purpose (cancel, dispose) is not a crash and records nothing against the file. The child gets an environment of `PATH`, temp-directory and locale variables only, never the parent's API keys, and runs under Node's permission model: it may read its script's directories and `node_modules`, and cannot write, spawn processes or start workers. The model does not restrict the network, and `--allow-addons` is required to load the native parser, so native code in the child is not itself confined; the empty environment is what limits what it can find. Checked with `oxc-parser` 0.155.0 on Node 22.13.0 and 24.19.0. The child starts in the temp directory, not the project. On Linux its core dump is limited to headers (`coredump_filter` 0). The parser's raw transfer maps a 6 GiB buffer, and a crash handler behind a pipe (apport, systemd-coredump) would otherwise be sent all of it, along with the source being parsed. The parse is bounded by what is left of the call's time (at least 10 seconds), and an idle child does not keep the host process alive. The parent's event loop is free while a large file parses. Raw transfer when the platform supports it, the ordinary parse otherwise. Source type is detected, with a CommonJS fallback; JavaScript is parsed with JSX on.
- **Store**: one SQLite database (`node:sqlite`) per root, in `cacheDir`, named by a hash of the root's real path, the schema version and the mode (`<hash>-v3-fts.sqlite`, `-scan`), so two package versions, or a Node with FTS5 and one without, never open the same file. Only a file SQLite calls corrupt is deleted; a busy one is waited for. **The cache keeps the string literals it indexed, secrets included, so it is trimmed**: when a provider first opens a cache file it touches it, removes databases unused for 30 days (`cacheMaxAgeDays`) and trims the least recently used until the directory is under 2 GiB (`cacheMaxBytes`), never the file in use and never one used in the last hour. Parsing happens outside any transaction; parsed files are written together in a short transaction every few dozen files, so a second process waits for one of those, not for the whole run. Writers take the write lock up front (`BEGIN IMMEDIATE`) and wait for it with an `await`, so several processes can index one root, and a terminal does not freeze behind another's index. With no `cacheDir`, or one that cannot be written, the index is held in memory and the summary says `persisted: false`.
- **Tables**: `files`, `dirs`, `excl` (what the walk saw and left out, by directory), `functions` (with the qualified name), `classes`, `strings` (with the original length of a cut literal), `calls` (with the class a `this.m()` belongs to), `imports`, `exports`, plus a trigram FTS5 table over literals for `find_literal`.
- **Loading**: `oxc-parser` and `node:sqlite` load on the first call. Nothing is imported when the package is.
- **Responsiveness**: indexing yields to the event loop every 20 ms.
- **What is indexed**: `.js .mjs .cjs .jsx .ts .mts .cts .tsx`, and extension-less scripts whose first line is a `node`, `bun` or `deno` shebang (`bin/mycli`). Not declaration files, symbolic links, or directories named `node_modules`, `.git`, `.hg`, `.svn`, `.namzu`, `.turbo`, `.cache`, `coverage`, `dist`, `build`, `out` or `.next` (`ignoreDirs` replaces that list; `dist`, `build` and `out` are skipped by default only beside a `package.json` or when a `.gitignore` lists them, so `src/build/` source is indexed, and a list you write is taken as written). **`.gitignore` files are honoured** (the root's and those in directories below it, never one that is a symbolic link, and a rule that cannot be compiled is dropped without failing the query; through the maintained [`ignore`](https://www.npmjs.com/package/ignore) package, MIT; `respectGitignore: false` turns it off), so build output and generated files are not a second copy of the source. Everything left out is counted and named in coverage. A binary file with a `.js` name is skipped by its bytes and counted. A path in an ignored directory is indexed when named: `index` with `path: dist` walks `dist`.
- **Literals**: kept whole up to 8,192 characters; a longer one keeps its first and last 4,096, so the start or the end of an embedded prompt or bundle is found and the middle is reported as unsearchable. A hit on a long literal shows the window around the match, not its first 200 characters.
- **Export forms**: destructured exports (`export const { a, b } = o`), type-only exports (`kind: 'type'`), CommonJS (`kind: 'commonjs'`: `module.exports`, the keys of `module.exports = { … }`, `exports.x`, `Object.defineProperty(exports, 'x', …)`), `export =` (`kind: 'assign'`). What a `require` binds is recorded (`* as fs`, `b, c as cc`, `pick`).

### Large roots

The index root is the session directory that contains the target, which can be a home directory. A call therefore stops at `maxDirectories` (default 20,000), `maxFiles` or `maxMillis` (default 45,000), keeps what it indexed, answers from it, and reports `IndexSummary.truncated` and coverage `partial`. The reason names every limit that was hit, and the next step depends on which: after the **time** limit, "call the index operation again to continue where it stopped" (the rest of the walk's files are still waiting); after the **directory** or **file** limit, "index a narrower path", because the same call will never get past it. Both together say both. `index` with a `path` (or `IndexRequest.scope`) indexes just that file or directory, and a query that names a path builds only that part. A query never retries a capped build; only an explicit `index` does. The most specific covering scope decides: once a narrower path has been indexed to completion, a query about it no longer tells you to index it. A cancelled call keeps what it committed, moves the generation so earlier cursors stop matching, and records the scope as partial with "call the index operation to continue".

### Node versions

`node:sqlite` needs no flag from Node 22.13. FTS5 is compiled into the official binaries from Node 22.16 and is absent from 22.13, 22.14 and 22.15 (checked against each). There the store still works and `find_literal` scans every literal instead of using the substring index: the same answers, and tens of milliseconds instead of one on a large bundle. `substringIndex: 'off'` forces the scan. The two modes use separate cache files. `node:sqlite` itself is missing before Node 22.5, below this package's engine floor; the provider then answers `unsupported`.

### Measured

On Node 24.19, pinned to two cores:

| Tree | Files | Cold index | Database | Warm refresh | One file added |
|---|---|---|---|---|---|
| A 44.5 MB bundle (2,434 files indexed, 3 binary skipped) | 2,434 | 7.2 s with FTS5, 5.9 s without | 148 MB with, 110 MB without | 0.15 s | 0.15 s |
| Namzu's `packages/*/src` (23 roots) | 4,228 | 5.5 s with, 4.8 s without | 100 MB with, 82 MB without (total) | 0.34 s (total) | |

The bundle holds 161,463 functions, 468,786 literals and 623,893 calls; peak resident memory was about 760 MB. Median query time on it: `find_literal` 0.5 ms with FTS5 and 54 ms without, `enclosing_function` 0.5 ms, `callers_of` 0.4 ms. The script is `packages/analysis/scripts/bench.mjs`, run by hand and not by CI.

After the quality pass (cache schema 2, same bundle, Node 24.19, not pinned to two cores): cold index 11.1 s, 178 MB, warm refresh 0.16 s. Every `find_literal` and workspace `callers_of` first compares the files in scope with the disk, which costs about 5 ms per thousand indexed files; a workspace `callers_of` on the bundle went from a median of 1.4 ms to 11 ms. Extraction against an independent TypeScript parse is unchanged: 161,463 of 161,463 functions, 623,893 of 623,893 calls and every string literal (the 17 template literals it cannot match are `String.raw` templates stored raw where the oracle reads them cooked), 0 missing and 0 extra.

## Limits

- Callers are matched by text, not scope or binding. A method's `this.m()` inside its class is resolved; every other receiver is `text-only`.
- A template literal is indexed one static chunk at a time: a search cannot span a `${...}`. The middle of a literal over 8,192 characters is not searchable. Regular expression literals and JSX text are not indexed.
- A file the parser cannot read is read after its broken lines are set aside, or by a scanner that finds strings and `function name(` only; a file that crashes the parser is recorded with no rows.
- Webpack module maps (`296:(e,t,r)=>{…}`, `r(296)`), bun and esbuild wrappers (`var X = C(function(){…})`), import resolution across files, and source maps are not modelled.
- A directory the indexer ignores (such as `node_modules`) is reachable by naming it: a call with that directory or a file in it as its path indexes it, because the ignore list applies below the path asked for.
- The index is syntactic. There is no type information.

For the terminal, see [Code analysis in the terminal](../cli/code-analysis.md).
