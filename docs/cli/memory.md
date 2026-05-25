---
title: Memory
description: How namzu remembers across sessions via ~/.namzu/USER.md and MEMORY.md, plus the /remember and /memory commands.
last_updated: 2026-05-25
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

`/recall` over past conversations is covered by [`/resume`](./tui.md#sessions--resume).
