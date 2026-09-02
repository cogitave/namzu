---
type: Reference
title: Context and compaction in the CLI
description: The file-only compaction key that picks the kernel's strategy or overrides the model's window, and the /context command that shows what compaction has done in a session.
resource: packages/cli/src/config/schema.ts
tags: [cli, compaction, config]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-02T00:00:00Z }
---

# Context and compaction in the CLI

# The `compaction` key

In `namzu.config.json` (project) or `~/.namzu/config.yaml` (user), never from the environment:

```json
{ "compaction": { "strategy": "salience", "contextWindowTokens": 200000 } }
```

| Field | Meaning |
| --- | --- |
| `strategy` | `structured` (the kernel's default) or `salience`, the scored working set described in [The salience-scored working set](../sdk/salience-working-set.md). |
| `contextWindowTokens` | The window the kernel measures fullness against, when the model's table entry is wrong or a project wants compaction earlier. Absent, the kernel resolves it from the model. |

A strategy is a property of a project's runs, which is why the key is file-only, like `hooks`.

# `/context`

Shows how full the window is and what compaction has done this session: the strategy with its thresholds (`salience` holds the context from half the window and summarises only at the trigger; `structured` waits for the trigger), then the passes so far — tool results cleared, narrations stubbed, summaries written, tokens reclaimed. Every pass also leaves a `⌫` row in the transcript where it happened. `/cost` keeps the cumulative token figure and names the strategy in its context line.
