---
type: Reference
title: The composer prefixes
description: What a line starting with `!` or `#` does in the CLI's composer — a command run on the host without the model, or a note remembered — and what the model learns of either.
resource: packages/cli/src/tui/shell-escape.ts
tags: [cli, composer, shell, memory]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-02T00:00:00Z }
---

# The composer prefixes

Two first characters make a line something other than a prompt.

## `!command` — the operator's own shell

`!ls -la` runs `ls -la` on the host, in the session's working directory, with the operator's environment and authority. It is not the model's `bash` tool: no model call is made, the authorization gate is not consulted, and the command does not enter the sandbox. The operator typing a command is the operator, not a tool call, and the gate exists to review the model.

What the operator sees: their line, then a row `! ls -la · exit 0` with the output under it. While the command runs the row shows `…`; a non-zero exit or a kill shows `✗`.

What the model sees: on its next turn, a system block naming every `!` command run since its last turn, with the output and the exit. A `!` line that left no trace for the model would be a command the operator then has to describe in prose.

Bounds: a command that has not ended after 60 seconds is killed with its whole process group, and the row says `killed after 60s`. Output is cut at 20,000 characters for the transcript and 8,000 for the model.

## `#note` — remember

`#always run tests with pnpm` remembers the note exactly as `/remember` does, and the row reads `Remembered: …`. A `#` with nothing after it is sent as a prompt.
