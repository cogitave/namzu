---
type: Reference
title: Run limits
description: Limits for interactive and headless runs, headless override flags, explicit reasoning effort and budget enforcement.
resource: packages/cli/src/commands/run-flags.ts
tags: [cli, run, config]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-04T00:00:00Z }
---

# Run limits

CLI runs default to 50 main-loop iterations, a one-hour run deadline and no cumulative token limit. Set a token budget explicitly to bound measured usage across the parent and its descendants. Token exhaustion remains distinct from successful completion.

- **`limits`** in `namzu.config.json` or `~/.namzu/config.yaml`: `{ "maxIterations": 400, "tokenBudget": 5000000, "timeoutMs": 3600000 }`. Keys may be omitted. Nonnegative safe integers; `0` disables the corresponding run guard. A positive `timeoutMs` must be at most 2,147,483,647 milliseconds to fit platform timers.
- **`--max-iterations <n>`** and **`--token-budget <n>`** on `run` and `run-stream` override the file for one run.

To remove all three run caps explicitly, put this in the workspace's
`namzu.config.json` (or the equivalent `limits` mapping in the user YAML file):

```json
{
  "limits": {
    "tokenBudget": 0,
    "maxIterations": 0,
    "timeoutMs": 0
  }
}
```

Zero is an explicit setting, so it can remove a cap inherited from user
configuration. `namzu run --token-budget 0 --max-iterations 0 "continue the work"`
removes those two caps for that headless invocation; its configured run deadline
still applies. `timeoutMs` is configured in the file, not a headless flag.

Unlimited execution still records measured own-run and descendant usage and
stops on completion or operator cancellation. It does not disable permissions,
context compaction, request output limits, per-tool deadlines, stream-silence
detection or unresolved-receipt handling. Provider quotas also remain external
constraints. Optional provider context-window discovery uses a five-second
fallback deadline when the run itself has no deadline.

The TUI also applies `limits.maxIterations`, `limits.tokenBudget` and `limits.timeoutMs` from the
resolved configuration, including when resuming a conversation or rebuilding
the session after a model change. User settings apply at launch; project
settings apply after workspace trust is established. Each ordinary new user
turn opens a run with these limits; durable recovery preserves the existing
run's ledger. `limits.waitForProviderMs` remains a headless wait policy.

To retain unlimited cumulative tokens in interactive use, omit `limits.tokenBudget`
from the effective config or set it to `0`. The omitted defaults stay
50 iterations, one hour and no cumulative token cap.

Interactive and headless sessions use the same token-budget default. Built-in
children inherit explicitly configured iteration and time limits, including `0`;
without those settings they retain 40 iterations and one hour. Their tokens
remain constrained by any finite ancestor allowance. File-defined specialist
agents retain their own iteration configuration. Context size is separate and
is governed by [compaction](context-and-compaction.md).

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
work from a limit-triggered stop, including a closing response at the warning
threshold. The TUI displays a stop notice alongside retained partial output;
closing prose does not establish that answer review passed. Token and cost limits are checked between calls using
reported usage; an in-flight response can cross a threshold, so these are not
provider-side billing caps. The configured token budget is shared by the parent
and its descendants. Under a finite parent limit each child reserves a finite allowance, and its unused
portion returns after execution settles. Unlimited children retain measured usage in the same ledger without a finite reservation. Parent calls, child calls and SDK
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
consuming tokens. A lost or incomplete provider receipt leaves unresolved spend. It blocks its own
account and accounts sharing a finite ancestor allowance; healthy siblings under
unlimited ancestors may continue. Usage totals remain explicitly incomplete. Waiting cannot establish the missing receipt;
the run must retain that uncertainty instead of reopening its allowance.
