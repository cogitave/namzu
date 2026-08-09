---
title: Memory
description: How namzu remembers across sessions via ~/.namzu/USER.md and MEMORY.md, plus the /remember and /memory commands.
last_updated: 2026-08-09
status: current
related_packages: ["@namzu/cli"]
---

# Memory

namzu remembers context across sessions using two flat markdown files under `~/.namzu/`:

- **`USER.md`** — durable facts about you (role, preferences, how you like to work).
- **`MEMORY.md`** — durable facts and decisions the agent should carry forward.

On every turn namzu reads both files and injects their contents into the agent's system prompt, so the model starts each turn already knowing what's stored. Memory is read fresh each turn, so edits take effect immediately, and it only ever enters the system prompt — it is never echoed back into the visible transcript.

When both files are empty or absent, nothing is injected and behavior is unchanged.

## Commands

| Command | Effect |
| --- | --- |
| `/remember <text>` | Append `<text>` as a bullet to `MEMORY.md`. |
| `/memory` | Show what's currently stored (both files). |

You can also edit `~/.namzu/USER.md` and `~/.namzu/MEMORY.md` directly in any editor — namzu picks up the changes on the next turn.

## Example

```
/remember I prefer tabs over spaces and concise commit messages
```

In a later session:

```
▸ you     what's my indentation preference?
◆ namzu   You prefer tabs over spaces.
```

## Scope and format

- The injected files are **user-global** (`~/.namzu/`), shared across every project you run namzu in.
- They're plain markdown — bullets in `MEMORY.md`, free-form prose or sections in `USER.md`. Keep them concise; everything is injected on every turn.

## Agent memory (structured)

Separately from the always-injected files above, the agent has its own **structured memory** it manages on demand via tools — `save_memory`, `search_memory`, and `read_memory` — backed by the SDK's store at `.namzu/memory`. namzu uses these to record and recall notes itself during a task (rather than everything living in the always-on prompt). You don't drive these directly; the `/remember` + `MEMORY.md`/`USER.md` flow above is the user-facing memory.

### What a run leaves behind on its own

namzu could **store** a memory and could not **form** one. Until now the only
path into the structured store was the model choosing to call `save_memory`, so
a run that worked something out and never thought to write it down lost it —
along with everything the compaction pass had already extracted and structured
on the way there.

Now, when a run settles, what it learned is offered to the same store
`search_memory` reads: the user requirements it was given, the decisions it
made, what it discovered, what it tried that did not work, and facts about the
environment. One markdown record per run, tagged `run-memory`, carrying the
run's id so a surprising memory can be traced back to what actually happened.

**This is on by default and it includes the interactive TUI**, not only
`namzu run` and `namzu run-stream`. All three are built on one session, and it
is the session that supplies the promoter. So an ordinary chat that works
something out now leaves a record under `<cwd>/.namzu/memory` — a directory
that used to grow only when the model chose to call `save_memory`.

There is no flag to turn it off. That is deliberate rather than an oversight:
the behaviour it replaces was a run's extracted knowledge being discarded at
settle, so a flag would leave the lossy behaviour as the default. What keeps it
quiet is the filter below.

**A run that learned nothing leaves nothing.** Not an empty record — nothing.
Only those five categories count. The task does not, because every run has one
and it is just the prompt restated; the list of files touched does not, because
every run that opened anything has one and it says what was *touched* rather
than what was *learned*. The model reads this store on later runs, so a record
per run would not merely waste disk: it would spend context on runs that
discovered nothing.

If entries were dropped during the run because a category filled up, the record
says so. Somebody reading it should know they are reading a truncated account.

Sub-agents do not write their own records. A task that delegated six times
would otherwise leave seven accounts of one piece of work for the next run to
read; the parent's settle speaks for the whole task.

A memory that fails to form never fails the run and never retracts an answer
that was already produced — the failure is logged and the run stands.

SDK hosts get the same thing as `createMemoryPromoter`, and can replace it
wholesale by passing their own `promoteMemory` to `query`. Deduplication,
merging with a previous run's record and expiry are deliberately not decided
here; they are policies a host owns.

`/recall` over past conversations is covered by [`/resume`](./tui.md#sessions--resume).
