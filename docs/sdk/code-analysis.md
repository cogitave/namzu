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
| `function_source` | `function_id` or `path` + `name`, `max_chars?`, paging | A function's exact source. |
| `callers_of` | `name`, `scope?`, `path?`, `match?`, paging | Call sites of a name, each with its enclosing function. |
| `imports` | `path`, paging | One file's imports and exports. |

All operations except `index` build the part of the index they need on first use and say so in `observed`. Call `index` to refresh after files changed, or with a narrower `path` to cover one part of a root at a time (see [Large roots](#large-roots)).

Every call takes the turn's abort signal. Cancelling an index abandons it and kills the parsing child; what it had already committed stays, so the next call continues from there. A call still queued behind another never starts.

### Positions

Lines and columns are **one-based**. Columns count **UTF-16 code units**, which is what a JavaScript string index is, so a character outside the Basic Multilingual Plane takes two. `start` and `end` are the same UTF-16 offsets into the file, half-open. A line ends at `\n`. A column past the end of its line is refused rather than clamped, because on a minified file a miscounted column would otherwise return the function around the wrong place with a citation that looks right.

A method's range is the method (`static async load(id) { ... }`), not the inner function expression the parser reports, which starts at the parameter list. Getters, setters, constructors, object methods and arrows assigned to properties are functions with their own ranges and names.

### Paging

Every list takes `limit` (default 50, at most 200) and `cursor`, and returns `total` for all pages. The cursor is opaque. It is bound to its query and to the index state it was cut from: replaying it on another query, or after the index changed, is an error that says to repeat the query without it, never a page from the wrong place.

### Staleness

The index is a snapshot. A hit whose file has since changed carries `stale: 'changed'` (its position may be off), one whose file was deleted carries `stale: 'deleted'`, and coverage says how many. Directories whose modification time moved since the index was built are named too, because files added there are not indexed (up to 400 directories are checked per query). A BOM is kept in the text, so a column on line 1 is a position in exactly the string `read` shows.

### Source slices

`enclosing_function` and `function_source` cut the function's source from the file and check it against the content hash recorded at index time. A file that changed is re-indexed first (or, for `function_source` by id, the call fails and says so, because ids are re-issued when a file is re-read). Slices are capped by `max_chars` (default 20,000, at most 200,000). A cut is reported (`cut: showing N of M characters`), never silent, and never lands inside a surrogate pair.

## Evidence

Every successful result carries three things beside the answer:

- `observed`: what the index read out of the files, as fact.
- `inferred`: what was concluded rather than read. The index does no scope analysis, so a callee matched by text is an inference, and the evidence says so. A call through an alias, a destructured binding, `.call` / `.apply` or `obj[name]()` is not matched, and the evidence says that too.
- `coverage`: `complete`, or `partial` with reasons: files skipped (binary, too large, over the file cap), files that did not parse, hits from files that changed on disk since they were indexed.

A parse failure matters here: for input it cannot recover from, the parser returns an empty program. Such a file is recorded, yields no rows, and turns coverage to `partial`, so an empty answer is never presented as a complete one.

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

`createCodeAnalysisProvider(options)` returns the provider. Options: `cacheDir`, `ignoreDirs`, `maxFileBytes`, `maxFiles`, `maxDirectories`, `maxMillis`, `hostScript`, `parserModule`, `cacheMaxAgeDays`, `cacheMaxBytes`, `substringIndex`.

- **Parser**: `oxc-parser`, pinned, in a child process (this package's `dist/indexer-host.js`, or the `hostScript` a bundling host names; the module is also exported as `@namzu/analysis/indexer-host` for a host to build as its own entry). On a handful of pathological inputs (a 6,000-deep array, 20,000 chained ternaries, 100,000 `+` terms, 100,000 nested calls, all measured on 0.155.0) it dies with SIGSEGV, which a worker thread does not isolate. The child names the file it is on; if it dies the parent records that file with no rows, reports `parser crashed` in coverage, starts a new child and carries on. A child the host kills on purpose (cancel, dispose) is not a crash and records nothing against the file. The child gets an environment of `PATH`, temp-directory and locale variables only, never the parent's API keys, and runs under Node's permission model: it may read its script's directories and `node_modules`, and cannot write, spawn processes or start workers. The model does not restrict the network, and `--allow-addons` is required to load the native parser, so native code in the child is not itself confined; the empty environment is what limits what it can find. Checked with `oxc-parser` 0.155.0 on Node 22.13.0 and 24.19.0. The child starts in the temp directory, not the project. On Linux its core dump is limited to headers (`coredump_filter` 0). The parser's raw transfer maps a 6 GiB buffer, and a crash handler behind a pipe (apport, systemd-coredump) would otherwise be sent all of it, along with the source being parsed. The parse is bounded by what is left of the call's time (at least 10 seconds), and an idle child does not keep the host process alive. The parent's event loop is free while a large file parses. Raw transfer when the platform supports it, the ordinary parse otherwise. Source type is detected, with a CommonJS fallback; JavaScript is parsed with JSX on.
- **Store**: one SQLite database (`node:sqlite`) per root, in `cacheDir`, named by a hash of the root's real path, the schema version and the mode (`<hash>-v1-fts.sqlite`, `-scan`), so two package versions, or a Node with FTS5 and one without, never open the same file. Only a file SQLite calls corrupt is deleted; a busy one is waited for. **The cache keeps the string literals it indexed, secrets included, so it is trimmed**: when a provider first opens a cache file it touches it, removes databases unused for 30 days (`cacheMaxAgeDays`) and trims the least recently used until the directory is under 2 GiB (`cacheMaxBytes`), never the file in use and never one used in the last hour. Parsing happens outside any transaction; parsed files are written together in a short transaction every few dozen files, so a second process waits for one of those, not for the whole run. Writers take the write lock up front (`BEGIN IMMEDIATE`) and wait for it with an `await`, so several processes can index one root, and a terminal does not freeze behind another's index. With no `cacheDir`, or one that cannot be written, the index is held in memory and the summary says `persisted: false`.
- **Tables**: `files`, `functions`, `strings`, `calls`, `imports`, `exports`, plus a trigram FTS5 table over literals for `find_literal`.
- **Loading**: `oxc-parser` and `node:sqlite` load on the first call. Nothing is imported when the package is.
- **Responsiveness**: indexing yields to the event loop every 20 ms.
- **What is indexed**: `.js .mjs .cjs .jsx .ts .mts .cts .tsx`. Not declaration files, symbolic links, `node_modules`, `.git`, `.hg`, `.svn`, `.namzu`, `.turbo`, `.cache` or `coverage`. A binary file with a `.js` name is skipped by its bytes and counted.

### Large roots

The index root is the session directory that contains the target, which can be a home directory. A call therefore stops at `maxDirectories` (default 20,000) or `maxMillis` (default 45,000), keeps what it indexed, answers from it, and reports `IndexSummary.truncated` and coverage `partial` naming the next step: index a narrower path. `index` with a `path` (or `IndexRequest.scope`) indexes just that file or directory, and a query that names a path builds only that part. A query never retries a capped build; only an explicit `index` does. The most specific covering scope decides: once a narrower path has been indexed to completion, a query about it no longer tells you to index it. A cancelled call keeps what it committed, moves the generation so earlier cursors stop matching, and records the scope as partial with "call the index operation to continue".

### Node versions

`node:sqlite` needs no flag from Node 22.13. FTS5 is compiled into the official binaries from Node 22.16 and is absent from 22.13, 22.14 and 22.15 (checked against each). There the store still works and `find_literal` scans every literal instead of using the substring index: the same answers, and tens of milliseconds instead of one on a large bundle. `substringIndex: 'off'` forces the scan. The two modes use separate cache files. `node:sqlite` itself is missing before Node 22.5, below this package's engine floor; the provider then answers `unsupported`.

### Measured

On Node 24.19, pinned to two cores:

| Tree | Files | Cold index | Database | Warm refresh | One file added |
|---|---|---|---|---|---|
| A 44.5 MB bundle (2,434 files indexed, 3 binary skipped) | 2,434 | 7.2 s with FTS5, 5.9 s without | 148 MB with, 110 MB without | 0.15 s | 0.15 s |
| Namzu's `packages/*/src` (23 roots) | 4,228 | 5.5 s with, 4.8 s without | 100 MB with, 82 MB without (total) | 0.34 s (total) | |

The bundle holds 161,463 functions, 468,786 literals and 623,893 calls; peak resident memory was about 760 MB. Median query time on it: `find_literal` 0.5 ms with FTS5 and 54 ms without, `enclosing_function` 0.5 ms, `callers_of` 0.4 ms. The script is `packages/analysis/scripts/bench.mjs`, run by hand and not by CI.

## Limits

- Callers are matched by text, not scope or binding.
- Literals are indexed up to 4096 characters, and a template literal one static chunk at a time: a search cannot span a `${...}`.
- A file with unrecoverable syntax errors has no rows, and one that crashes the parser is recorded with none.
- A directory the indexer ignores (such as `node_modules`) is reachable by naming it: a call with that directory or a file in it as its path indexes it, because the ignore list applies below the path asked for.
- The index is syntactic. There is no type information.

For the terminal, see [Code analysis in the terminal](../cli/code-analysis.md).
