---
type: Reference
title: Run limits
description: How far one headless run may go before the kernel stops it — the limits config key, the --max-iterations and --token-budget flags, and what the defaults were sized for.
resource: packages/cli/src/commands/run-flags.ts
tags: [cli, run, config]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-04T00:00:00Z }
---

# Run limits

Every run has two leashes: how many model calls it may make and how many tokens it may spend in total. The defaults, 50 calls and one million tokens, are sized for a chat turn. A long autonomous task outgrows them, and used to hit them silently: the run settled as if finished.

- **`limits`** in `namzu.config.json` or `~/.namzu/config.yaml`: `{ "maxIterations": 400, "tokenBudget": 5000000 }`. Either key may be omitted. Whole numbers above zero.
- **`--max-iterations <n>`** and **`--token-budget <n>`** on `run` and `run-stream` override the file for one run.

The interactive session keeps the chat-turn defaults; a turn there is a conversation, not a task. Context size is a separate matter and is governed by [compaction](context-and-compaction.md), which keeps the working set under the model's window however long the run goes.

## Waiting for the provider

A third leash is time spent waiting. When the provider pauses a run — a rate limit, an outage — the kernel keeps a checkpoint and the run cannot go on until the provider allows it. Without a wait budget `namzu run` exits 75 at once and leaves the decision to whatever called it. With one, the run waits and resumes from the checkpoint in the same process, keeping its own context rather than being re-prompted from notes.

```
namzu run --wait-for-provider 2h "migrate the fixtures"
```

The flag takes a duration (`90s`, `30m`, `2h`, or a bare number of seconds). The config key `limits.waitForProviderMs` sets the same budget, in milliseconds, for every run in the folder; the flag overrides it. The default is no budget.

Each wait is the provider's own delay when it named one, with a one-second floor so a provider that says "now" is not polled. When it named none, the wait backs off: a minute, then two, then four, capped at fifteen. A wait that would take the total past the budget is not taken; the run stops with 75 and says how much it had spent and what the next wait would have been. A pause with no provider behind it — a run parked on something else — is never waited on.

The resumed run is the same run: its checkpoint carries the messages, the working state and the compaction summary, so the model continues from where the provider stopped it, not from a fresh prompt.
