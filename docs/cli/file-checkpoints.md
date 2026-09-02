---
type: Reference
title: File checkpoints
description: How the interactive session records every file before a tool changes it, per turn, and how /restore puts the tree back to before a turn — what is covered, what is not, and how it pairs with Esc Esc.
resource: packages/cli/src/checkpoints/store.ts
tags: [cli, files, safety]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-02T00:00:00Z }
---

# File checkpoints

Before the `edit` or `write` tool changes a file, the session records the file as it is — or that it does not exist. One record per file per turn, the first change's; a second edit to the same file in the same turn does not overwrite what the turn started from. The records live under the project's private state, per session, and are dropped when the session closes.

## `/restore`

`/restore` lists the turns that changed files, numbered, with the prompt that started each and the files it touched.

`/restore N` puts every file back to its state before turn N, undoing N and every later turn: files the model changed are rewritten, files it created are removed. Later turns are undone first, so a file touched in several turns ends at its oldest recorded state. The undone turns leave the list. The model is told what was put back before its next turn, so it does not keep reasoning from a tree that no longer exists.

A restore is refused while a turn is running.

## What is and is not covered

- **Covered**: files under the working directory changed by the session's own `edit` and `write` tools, in the sandbox or out of it.
- **Not covered**: a shell command's writes (`bash`, a `!` line), a sub-agent's writes, files outside the working directory, and files over 8 MB. `/restore` lists what it can put back and nothing else; a tree that also changed through a shell is restored for the tool writes only.

## With Esc Esc

Esc Esc on an empty composer forks the conversation before an earlier prompt and reopens it. It does not touch files. To go back in both — the conversation and the tree — use `/restore N` for the files, then Esc Esc for the prompt.
