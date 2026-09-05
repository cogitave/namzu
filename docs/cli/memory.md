---
type: Reference
title: Memory
description: The two memories the interactive session keeps — the curated files injected into every turn, per project and per user, and the kernel's searchable store — where each lives, what writes to it, and the cap that keeps them from eating the context.
resource: packages/cli/src/memory/store.ts
tags: [cli, memory, prompt]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-04T00:00:00Z }
---

# Memory

There are two kinds, and they do different jobs.

## Curated memory: read into every turn

Three files, two scopes. Each is markdown the operator may edit by hand.

| File | Scope | What belongs there |
| --- | --- | --- |
| `<project>/.namzu/MEMORY.md` | project | facts about this repository: how tests run, what a name means here, a decision taken |
| `~/.namzu/MEMORY.md` | user | facts that hold in every project |
| `~/.namzu/USER.md` | user | who the operator is |

`#note` in the composer and `/memory <text>` append to the **project** file: a note typed while working in a repository is almost always about that repository. `/memory --user <text>` appends to the user file. `/memory` alone shows what the next turn will be given.

For new files, `<project>` is the nearest checkout root (a `.git` directory or worktree `.git` file), or the working directory when outside a repository. Launching from `packages/cli` therefore reads and writes the checkout's memory. An existing `.namzu/MEMORY.md` in the working directory takes precedence, including an empty file, so old directory-specific notes remain accessible. Create that file explicitly to keep directory-specific memory. This changes the default destination for a new note from a repository subdirectory; it does not move existing files.

Every turn's system prompt carries all three, each capped at 8,000 characters: the head is kept and a line says how much the file holds beyond it. The fix for a capped section is to curate the file, which is what a curated memory is for.

## The kernel's store: searched, not injected

`save_memory`, `search_memory` and `read_memory` are the model's own memory, kept in the project's state directory and found by search when the model asks. Consolidation (`compaction.consolidate`) writes a run's learnings there. Nothing in it reaches the prompt unasked, so it can grow without cost.

## What changed

Until this version `#note` and `/memory` wrote to the user file, so a fact about one repository followed the operator into every other, and the files were injected whole, however long.
