<!-- okf
type: Reference
title: "@namzu/analysis"
description: >-
  A native, paged semantic index of JavaScript and TypeScript for Namzu agents.
  Finds a string literal, the function around it, that function's exact source
  and its callers by name, with cited, evidence-carrying results.
tags: [readme, package, analysis, code-index, sqlite]
status: stable
generated: { by: human:bahadirarda, at: 2026-10-21T00:00:00Z }
-->

<div align="center">

<h1>@namzu/analysis</h1>

**A paged semantic index of JavaScript and TypeScript, for agents that read code they did not write.**

[![npm](https://img.shields.io/npm/v/@namzu/analysis.svg)](https://www.npmjs.com/package/@namzu/analysis)
[![build](https://github.com/cogitave/namzu/actions/workflows/ci.yml/badge.svg)](https://github.com/cogitave/namzu/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)

[Install](#install) · [Usage](#usage) · [What it answers](#what-it-answers) · [Documentation](#documentation)

</div>

---

`grep` finds a string and says nothing of the function around it. A language
server resolves symbols a project's own types can see, and has nothing to say
about a 40 MB bundle with no types and a hundred one-letter names. This package
is for that case: *which function holds this string, what is its exact source,
and who calls it by name* — over code nobody wrote for you to read.

It parses with [`oxc-parser`](https://oxc.rs), streams rows per file into a
SQLite database (`node:sqlite`), and answers from there. Nothing heavy loads
until the first call.

## Install

```bash
pnpm add @namzu/sdk @namzu/analysis
```

`@namzu/sdk` is a peer dependency, used for the interface this package
implements. Node 22.13 or newer.

## Usage

```ts
import { createCodeAnalysisProvider } from '@namzu/analysis'
import { getCodeAnalysisTools, toolset } from '@namzu/sdk'

const codeAnalysis = createCodeAnalysisProvider({
  // Where the per-root index files live. Omit it for an in-memory index.
  cacheDir: '/var/cache/my-agent/analysis',
})

// For an agent: the `code_analysis` tool, and the provider on the turn.
const tools = toolset('code-analysis', getCodeAnalysisTools(codeAnalysis))
// …then `query({ ..., codeAnalysis })`.

// As a library:
const hits = await codeAnalysis.findLiteral({ root: '/path/to/app', text: 'Invalid token' })
if (hits.kind === 'ok') {
  for (const hit of hits.value.items) {
    console.log(`${hit.path}:${hit.line}:${hit.column}`, hit.function?.name)
  }
}

await codeAnalysis.dispose()
```

## What it answers

| Operation | Question |
|---|---|
| `index` | Build or refresh the index for a root. Incremental by size, mtime and content hash. |
| `findLiteral` | Where does this string appear, and in which function? |
| `enclosingFunction` | Which function contains `file:line:column`? Its exact source, range and parents. |
| `functionSource` | The source of a function, by id or by file and name. |
| `callersOf` | Call sites of a name — per file by default, workspace-wide on request. |
| `imports` | One file's imports and exports. |

Every list is paged (`limit`, `cursor`, `total`). Every result is cited, with
one-based lines and one-based columns counted in UTF-16 code units, and carries
three things next to the answer:

- **observed**: what was read out of the files;
- **inferred**: what was concluded rather than read. `callersOf` matches by
  callee *text*, so two unrelated functions with one name are the same callee;
- **coverage**: `complete`, or `partial` with the reasons (a file that did not
  parse, a binary file skipped, a file that changed on disk since it was
  indexed).

Source slices are cut from the file and checked against its content hash, and
capped at a size you choose. A cut is reported, never silent.

## Indexing

- **Files**: `.js .mjs .cjs .jsx .ts .mts .cts .tsx`. Declaration files,
  symbolic links, `node_modules`, `.git` and similar are not entered. A binary
  file with a `.js` name is skipped and counted, not a crash.
- **Cache**: one SQLite file per root, named by a hash of the root's real path,
  the schema version and the mode, in `cacheDir`. A busy file is waited for,
  never deleted; only a corrupt one is. An unwritable directory falls back to
  memory and the summary says `persisted: false`. Several processes can index
  one root at once.
- **Parsing runs in a child process.** The native parser can segfault on
  pathological input (a 6,000-deep array, 100,000 chained terms). That costs
  one file, reported as `parser crashed` in coverage, not your process, and
  your event loop stays free while a large file parses.
- **Never outside the root.** Links are not followed, and a file replaced by
  a link after indexing is dropped without being read.
- **Limits**: files over 32 MiB and trees over 150,000 files are cut and
  reported (`maxFileBytes`, `maxFiles`). A call stops after 20,000
  directories or 45 seconds (`maxDirectories`, `maxMillis`), keeps what it
  indexed and names a narrower path to index next; it is never a refusal.
- **Cancelling**: every call takes a `signal`. An aborted index keeps what it
  committed.

## Node versions

`node:sqlite` needs no flag from Node 22.13. The substring index behind
`findLiteral` uses SQLite FTS5, which the official binaries include from Node
22.16 and lack on 22.13 through 22.15. There `findLiteral` scans every literal
instead: same answers, tens of milliseconds instead of one on a large bundle.
The database records which mode it was built in; `substringIndex: 'off'` forces
the scan.

## Limits worth knowing

- Callers are matched by text, not by scope. Calls through an alias, a
  destructured binding, `.call` / `.apply` or `obj[name]()` are not matched.
- Literals are indexed up to 4096 characters, and a template literal one static
  chunk at a time.
- A file with syntax errors is recorded but may yield no rows; coverage says so.
- There is no type information. This is a syntactic index.

## Documentation

- [Code analysis](https://github.com/cogitave/namzu/blob/main/docs/sdk/code-analysis.md)
- [The `code_analysis` tool in the CLI](https://github.com/cogitave/namzu/blob/main/docs/cli/code-analysis.md)

## Benchmark

An opt-in script, not run by CI:

```bash
pnpm --filter @namzu/analysis build
node packages/analysis/scripts/bench.mjs --root /path/to/tree
```

## License

[FSL-1.1-MIT](https://github.com/cogitave/namzu/blob/main/LICENSE.md)
