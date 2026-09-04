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
