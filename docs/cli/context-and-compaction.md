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
| `strategy` | `salience` (the default), the scored working set described in [The salience-scored working set](../sdk/salience-working-set.md), or `structured`, the previous behaviour: positional retention and a pass only at the trigger. |
| `contextWindowTokens` | The window the kernel measures fullness against, when the model's table entry is wrong or a project wants compaction earlier. Absent, the kernel resolves it from the model. |
| `consolidate` | `true` writes what each run learned — decisions, discoveries, failures, files changed — to the project's memory store when the run ends, as one entry tagged `learning` that `search_memory` finds in a later session. Off by default. |

A strategy is a property of a project's runs, which is why the key is file-only, like `hooks`.

# `/context`

The short report shows the latest context token count, window size and
percentage, followed by cleanup passes and estimated tokens freed this
session. It labels whether the token count was measured by the provider or
estimated by Namzu, and whether the window was declared or assumed. An
approximate percentage is marked with `~`; missing measurements are reported
as unavailable rather than zero.

`/context details` adds the strategy and thresholds, the number of tool results
cleared, messages shortened and summaries written. `salience` starts reducing
less useful content at its soft target and summarises older history at its
trigger; `structured` clears older tool results at its trigger and summarises
when needed. Every completed pass also leaves a `⌫` row in the transcript.
These cleanup counters cover the session, while the context size is the latest
reported measurement and can fall after cleanup.

`/cost` reports tokens and own model-call cost for the current or latest run.
It does not accumulate every conversation turn and does not use token spend
as a context-fullness gauge. Delegated token usage, when available, is labelled
separately. `/cost details` shows pricing scope and any context measurement;
unknown prices, measured zero and partly priced usage remain distinguishable.
