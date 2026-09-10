---
type: Reference
title: CLI release validation
description: Local terminal acceptance evidence and its limits for the pending release.
resource: packages/cli/src/tui/App.tsx
tags: [cli, testing, release]
---

# CLI release validation

On 2026-09-10, the built CLI was exercised in a real POSIX pseudo-terminal,
110 columns by 30 rows, in an isolated example directory with separate Namzu
state. The live provider was `codex`, model `gpt-5.6-luna`, effort `low`.
The README image is this terminal's interpreted viewport, not a desktop capture
or an invented model response. It contains only an example project.

Observed acceptance checks:

- A user request created `greet.ts` with an exported greeting function.
- After exiting, the same conversation was reopened using `namzu resume <id>`.
  A comment had been inserted into the file outside Namzu. The resumed agent
  read the file and added a farewell function, preserving that comment.
- A subsequent request launched two read-only explore agents. The terminal
  presented a grouped approval. After approval, both child run records settled
  as `completed` and their findings appeared in the parent response.
- `/status` displayed the CLI installation identity alongside session state.

An initial automation attempt missed the folder-trust input; another stopped
at the agent approval without accepting it. Those attempts are not successful
agent runs. The successful retries explicitly supplied the corresponding
terminal input. No provider errors occurred in the completed checks.

These are bounded integration checks, not a long-horizon quality benchmark.
They do not establish crash recovery during an in-flight mutation, steering
while children run, automatic compaction quality, other providers' availability,
or AG-UI frontend-tool and interrupt support. Those need separate acceptance
scenarios. Automated unit, process, coverage, documentation, eval and packaged
consumer checks supplement this terminal evidence; they do not replace it.
