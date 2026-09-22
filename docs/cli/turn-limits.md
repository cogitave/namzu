---
type: Reference
title: Turn limits
description: Limits for interactive and headless turns, headless override flags, explicit reasoning effort and budget enforcement.
resource: packages/cli/src/commands/exec-flags.ts
tags: [cli, limits, config]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-04T00:00:00Z }
---

# Turn limits

CLI turns default to unlimited main-loop iterations, turn duration and cumulative tokens. This applies to interactive turns, headless turns and built-in delegated agents. Set a token budget explicitly to bound measured usage across the parent and its descendants. Token exhaustion remains distinct from successful completion.

- **`limits`** in `namzu.config.json` or `~/.namzu/config.yaml`: `{ "maxIterations": 400, "tokenBudget": 5000000, "timeoutMs": 3600000 }`. Keys may be omitted. Nonnegative safe integers; `0` disables the corresponding turn guard. A positive `timeoutMs` must be at most 2,147,483,647 milliseconds to fit platform timers.
- **`--max-iterations <n>`** and **`--token-budget <n>`** on `namzu exec` (either mode) override the file for one invocation.

To remove all three caps explicitly, put this in the workspace's
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
configuration. `namzu exec --token-budget 0 --max-iterations 0 "continue the work"`
removes those two caps for that headless invocation; its configured turn deadline
still applies. `timeoutMs` is configured in the file, not a headless flag.

Unlimited execution still records the turn's own and descendant usage and
stops on completion or operator cancellation. It does not disable permissions,
context compaction, request output limits, per-tool deadlines, stream-silence
detection or unresolved-receipt handling. Provider quotas also remain external
constraints. Optional provider context-window discovery uses a five-second
fallback deadline when the turn itself has no deadline.

The TUI also applies `limits.maxIterations`, `limits.tokenBudget` and `limits.timeoutMs` from the
resolved configuration, including when resuming a conversation or rebuilding
the session after a model change. User settings apply at launch; project
settings apply after workspace trust is established. Each ordinary new user
turn starts with these limits; durable recovery preserves the existing
turn's ledger. `limits.waitForProviderMs` remains a headless wait policy.

Omitting the three limits or setting them to `0` leaves those guards unlimited.
An explicit positive value in the effective config still takes precedence.

Interactive and headless sessions use the same token-budget default. Built-in
children inherit explicitly configured iteration and time limits, including `0`;
without those settings their turn guards are unlimited. Their tokens
remain constrained by any finite ancestor allowance. File-defined specialist
agents retain their own iteration configuration. Context size is separate and
is governed by [compaction](context-and-compaction.md).

## Editing limits in the TUI

Open `/config` → limits (or `/config limits`). The picker shows the
current token budget, model-turn limit and duration. Enter on a row opens its
value editor; `0` or `unlimited` removes that cap. Duration accepts `30m`, `2h`,
`1500ms`, or a bare millisecond count. The remove-all row sets all three to
unlimited. Esc in an editor keeps the previous value.

The same controls accept direct input:

```text
/config limits tokens 200000
/config limits iterations 100
/config limits time 2h
/config limits unlimited
```

These are host controls, so they do not call a model. Overrides apply to new
turns and their built-in delegated agents for this TUI session, including after
a model change. A running turn keeps the snapshot it started with; editing a
limit does not refill its ledger. Resuming a parked CLI turn reloads the limits
its `turn_started` record saved instead of using new launch defaults. Invalid or
mismatched limits refuse recovery. Usage remains measured.
The picker labels this scope explicitly. To keep a limit across launches, set
it in `namzu.config.json` or the user config file; the TUI does not rewrite those
files. `/config sources` continues to describe launch-time file provenance.

**Default migration:** main turns previously omitted to 50 iterations, built-in
children to 40, and both to one hour. Hosts that require bounded CLI execution
must now set positive limits explicitly. For example, `{ "maxIterations": 50,
"timeoutMs": 3600000 }` restores those main-turn caps and applies the same values
to built-in children. The SDK's own embedding defaults are unchanged.

## Reasoning effort and budget enforcement

`namzu exec` accepts `--effort <level>` in either mode. An explicit level reaches the
provider unchanged; omitting it preserves the provider default. The parser
accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` and `ultra`;
the selected model must support the chosen level. Unsupported levels are
errors, never silently mapped to a different level. The flag applies to the
main turn; separately configured delegation has its own model settings.

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
and dollar limits remain local to each turn; see [Token budgets](../sdk/token-budgets.md).

Usage events retain the turn's own `usage` and add a `budget` summary.
`budget.ownTokens` is this turn's measured spend, `budget.treeTokens` includes its
descendants, and `budget.reservedTokens` is allowance still held by unfinished
children. These are cumulative snapshots; do not sum successive events.

`namzu exec --json` emits one terminal `done` event, after session cleanup and the
attempt to persist history. A persistence notice precedes that terminal event;
its stop reason is preserved. When the kernel supplies a settled result,
`done.text` contains that result, including an intentional empty string. Streamed
`delta` events may contain progress and answers later rejected by review; hosts
should use `done.text` for the final-answer artifact instead of concatenating all
deltas. An interrupted turn with no settled result can omit `text`; already emitted
deltas cannot be retracted. Full conversation history retains its message and
runtime-feedback boundaries. Fallback answer-only persistence uses the settled
text when available.

## Waiting for the provider

A third leash is time spent waiting. When the provider pauses a turn — a rate limit, an outage — the kernel keeps a checkpoint and the turn cannot go on until the provider allows it. Without a wait budget `namzu exec` exits 75 at once and leaves the decision to whatever called it. With one, the turn waits and resumes from the checkpoint in the same process, keeping its own context rather than being re-prompted from notes.

```
namzu exec --wait-for-provider 2h "migrate the fixtures"
```

The flag takes a duration (`90s`, `30m`, `2h`, or a bare number of seconds). The config key `limits.waitForProviderMs` sets the same budget, in milliseconds, for every headless invocation in the folder; the flag overrides it. The default is no budget.

Each wait is the provider's own delay when it named one, with a one-second floor so a provider that says "now" is not polled. When it named none, the wait backs off: a minute, then two, then four, capped at fifteen. A wait that would take the total past the budget is not taken; the turn stops with 75 and says how much it had spent and what the next wait would have been. A pause with no provider behind it — a turn parked on something else — is never waited on.

The resumed turn is the same turn, under the same turn id: its checkpoint names the point in the session log its context folds from and carries the working state, so the model continues from where the provider stopped it, not from a fresh prompt.


The token ledger survives independently of the message checkpoint. A typed
request rejection before generation, such as throttling, can resume without
consuming tokens. A lost or incomplete provider receipt leaves unresolved spend. It blocks its own
account and accounts sharing a finite ancestor allowance; healthy siblings under
unlimited ancestors may continue. Usage totals remain explicitly incomplete. Waiting cannot establish the missing receipt;
the turn must retain that uncertainty instead of reopening its allowance.

A stopped TUI turn distinguishes a depleted token allowance from missing request
usage or an accounting failure. The latter can also stop an unlimited turn; the
notice reports uncertainty rather than claiming the configured allowance ran out.
`/cost` shows the available measurements, not a fabricated complete total.
