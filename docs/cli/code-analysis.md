---
type: Reference
title: Code analysis in the terminal
description: The code_analysis tool in the interactive terminal, where its index is kept, what it costs, what it will not read, and the codeAnalysis config key that turns it off.
resource: packages/cli/src/integrations/analysis/provider.ts
tags: [cli, analysis, tools, config]
status: stable
generated: { by: claude-code/sonnet-5.5, at: 2026-10-21T00:00:00Z }
---

# Code analysis in the terminal

The interactive terminal offers a `code_analysis` tool. It answers the questions `grep` answers badly: which function holds a string, what is that function's whole source, who calls it by name, what does a file import. Each result is paged and cited as `path:line:column`, and says what was observed, what was inferred and whether coverage is complete. The tool, its operations and its evidence are described in [Code analysis](../sdk/code-analysis.md); this page is what the terminal does with it.

## On by default

There is nothing to install or enable. The CLI ships `@namzu/analysis` and the native parser it needs (`oxc-parser`). Two things follow from that:

- **It adds to every request.** The tool's description and input schema are about 4,000 characters, roughly 1,000 tokens, sent with each model request, about three times what `grep` costs. Turn the tool off if you never read unfamiliar code (see below).
- **It costs nothing until used.** The package, the parser and `node:sqlite` are loaded, and the index is built, only when the model first calls the tool. The first frame and the module count at startup are unchanged.

## Where the index lives

`~/.namzu/cache/analysis` (under `NAMZU_HOME` when set), one SQLite file per project root, named by a hash of the root's real path, created owner-only. It is a cache: delete it freely and the next call rebuilds it. A re-index reads only files whose size and mtime changed, and parses only those whose content hash changed. If the directory cannot be created, the index is held in memory for the session.

The first call in a project builds the index and says so in the result (`the index for ... did not exist and was built for this call`). On a few thousand files that takes a few seconds; a 44 MB bundle took 7 seconds on two cores. Call `index` again after files change to refresh.

## What it reads

The session's working directory and any directory added with [`/add-dir`](add-dir.md). It uses the same path rules and the same review as `read`: a path outside those directories is reviewed before the call runs, or refused with the same message `read` gives. It does not enter `node_modules`, `.git`, `.namzu` or similar, does not follow symbolic links, and skips binary files. To look inside `node_modules/some-package`, add that directory to the session.

It reads the host file system. In a turn that runs in a sandbox it refuses and points at `grep` and `read`.

## Where it is offered

The interactive terminal only. `exec`, `exec --json`, `drain`, `acp`, scheduled jobs and sub-agents do not mount it, for the reason the browser tools are not mounted there either: nobody is at the window, and a sub-agent builds its own roster.

## Turning it off

```json
{ "codeAnalysis": { "enabled": false } }
```

In your user config, a project's `namzu.config.json` or a managed file. `enabled: false` in any file holds: a later file cannot switch it back on. The tool is then absent from the session, and the index is never built. The key is not settable from the environment.

| Key | Default | Effect |
|---|---|---|
| `codeAnalysis.enabled` | `true` | Mount the `code_analysis` tool in the interactive terminal. |

An unknown key under `codeAnalysis` or a non-boolean `enabled` is refused when the config loads, not dropped.

## Troubleshooting

- **"The code index could not be loaded"**: the parser's native binary is missing for this platform. Reinstall the CLI; the answer is an `unsupported` result, so the model falls back to `grep`.
- **Coverage says `partial`**: read the reasons. Binary files, files over 32 MiB, trees over 150,000 files, files with syntax errors and files that changed since the last index each say so.
- **A hit points at the wrong place**: the file changed after it was indexed. The result says `changed on disk since they were indexed`; call `index`.
- **Results seem slow on Node 22.13 to 22.15**: those versions' SQLite has no FTS5, so `find_literal` scans. Node 22.16 or newer uses the substring index.
