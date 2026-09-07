---
type: Reference
title: Run limits
description: How far one headless run may go before the kernel stops it — the limits config key, the --max-iterations and --token-budget flags, explicit reasoning effort, and budget enforcement.
resource: packages/cli/src/commands/run-flags.ts
tags: [cli, run, config]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-04T00:00:00Z }
---

# Run limits

Every run limits its main-loop iterations and the tokens spent by its delegation tree. The defaults, 50 iterations and one million tokens, are sized for a chat turn. A long autonomous task outgrows them, and used to hit them silently: the run settled as if finished.

- **`limits`** in `namzu.config.json` or `~/.namzu/config.yaml`: `{ "maxIterations": 400, "tokenBudget": 5000000 }`. Either key may be omitted. Whole numbers above zero.
- **`--max-iterations <n>`** and **`--token-budget <n>`** on `run` and `run-stream` override the file for one run.

The interactive session keeps the chat-turn defaults; a turn there is a conversation, not a task. Context size is a separate matter and is governed by [compaction](context-and-compaction.md), which keeps the working set under the model's window however long the run goes.

## Reasoning effort and budget enforcement

`run` and `run-stream` accept `--effort <level>`. An explicit level reaches the
provider unchanged; omitting it preserves the provider default. The parser
accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` and `ultra`;
the selected model must support the chosen level. Unsupported levels are
errors, never silently mapped to a different level. The flag applies to the
main run; separately configured delegation has its own model settings.

An exhausted iteration, token, cost or elapsed-time guard stops without making
an additional model call just to produce a closing summary. Finalization advice
may be sent while budget remains. Stop reasons continue to distinguish finished
work from exhaustion. Token and cost limits are checked between calls using
reported usage; an in-flight response can cross a threshold, so these are not
provider-side billing caps. The configured token budget is shared by the parent
and its descendants. Each child reserves a finite allowance, and its unused
portion returns after execution settles. Parent calls, child calls and SDK
advisory/compaction calls consume the same tree allowance. Iteration, elapsed-time
and dollar limits remain local to each run; see [Token budgets](../sdk/token-budgets.md).

Usage events retain the run's own `usage` and add a `budget` summary.
`budget.ownTokens` is this run's measured spend, `budget.treeTokens` includes its
descendants, and `budget.reservedTokens` is allowance still held by unfinished
children. These are cumulative snapshots; do not sum successive events.

`run-stream` emits one terminal `done` event, after session cleanup and the
attempt to persist history. A persistence notice precedes that terminal event;
its stop reason is preserved. When the kernel supplies a settled result,
`done.text` contains that result, including an intentional empty string. Streamed
`delta` events may contain progress and answers later rejected by review; hosts
should use `done.text` for the final-answer artifact instead of concatenating all
deltas. An interrupted run with no settled result can omit `text`; already emitted
deltas cannot be retracted. Full conversation history retains its message and
runtime-feedback boundaries. Fallback answer-only persistence uses the settled
text when available.

## Waiting for the provider

A third leash is time spent waiting. When the provider pauses a run — a rate limit, an outage — the kernel keeps a checkpoint and the run cannot go on until the provider allows it. Without a wait budget `namzu run` exits 75 at once and leaves the decision to whatever called it. With one, the run waits and resumes from the checkpoint in the same process, keeping its own context rather than being re-prompted from notes.

```
namzu run --wait-for-provider 2h "migrate the fixtures"
```

The flag takes a duration (`90s`, `30m`, `2h`, or a bare number of seconds). The config key `limits.waitForProviderMs` sets the same budget, in milliseconds, for every run in the folder; the flag overrides it. The default is no budget.

Each wait is the provider's own delay when it named one, with a one-second floor so a provider that says "now" is not polled. When it named none, the wait backs off: a minute, then two, then four, capped at fifteen. A wait that would take the total past the budget is not taken; the run stops with 75 and says how much it had spent and what the next wait would have been. A pause with no provider behind it — a run parked on something else — is never waited on.

The resumed run is the same run: its checkpoint carries the messages, the working state and the compaction summary, so the model continues from where the provider stopped it, not from a fresh prompt.


The token ledger survives independently of the message checkpoint. A typed
request rejection before generation, such as throttling, can resume without
consuming tokens. A lost or incomplete provider receipt leaves unresolved spend
and prevents new model admissions. Waiting cannot establish the missing receipt;
the run must retain that uncertainty instead of reopening its allowance.
