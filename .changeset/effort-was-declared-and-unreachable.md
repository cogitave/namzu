---
'@namzu/sdk': minor
'@namzu/anthropic': patch
---

`effort` can be set on a run — and so, for the first time, can `thinking`.

`effort` was on the provider params, exported, and read by a driver that wrote
it to the wire, and nothing in the kernel ever set it. Every request went out at
the model's default, which reads as "this model ignores effort" rather than
"nobody plumbed it through".

`AgentRunConfig` gains `effort`, a sibling of `thinking` rather than a field
inside it — on some models the two are independent controls that apply together,
and nesting would make that combination unsayable. It is run-level rather than
per-step because the provider documents that changing effort between requests
does not preserve a cached prefix, so a value that moves between steps buys a
different answer shape at the cost of the cache on every step that changes it.

**`thinking` turned out to have the same defect, and had shipped with it.** It
was settable only through `drainQuery`. Every ergonomic entry point — `runAgent`,
`ReactiveAgent`, `SupervisorAgent`, and the agent manager's bare-config branch —
builds its run config by hand-listing fields, so a field nobody remembered to add
is dropped in silence, with no cast to blame and no error to see. A caller could
set `thinking` on an agent config and get a run that never asked for it. Both
fields now live on `BaseAgentConfig` and are forwarded by all four.

This was found by watching an actual HTTP body from a real run. The unit tests
passed throughout, because they drive the kernel directly, and the kernel was
never the half that was broken.

**A driver that cannot honour `effort` now refuses rather than dropping it**,
the rule `thinking` already had. Effort is the worse silence of the two: a
dropped `thinking` leaves an empty reasoning list someone might notice, while a
dropped `effort` leaves a perfectly ordinary answer, so a run requested at `max`
is indistinguishable from one at the default — including in what it cost.
Nothing existing breaks, because the field could not be set until now.

Two driver-side corrections ride along, both verified against the live wire:

- The preview model's capability row claimed all five effort levels. It takes
  `max` and not `xhigh`. That model is not reachable from the tenant the live
  suite runs against, so the row is sourced from the reference rather than
  measured — but the pairing itself is now measured, on a model that has it:
  `claude-sonnet-4-6` answers `xhigh` with *"This model does not support effort
  level 'xhigh'. Supported levels: high, low, max, medium"* and accepts `max`.
  Reading the levels as a ladder, where anything taking the top rung takes the
  one below, is what produced the wrong row.
- `output_config` is now merged rather than assigned. It is a shared envelope on
  that wire — a structured-output format and a task budget live in it too — so
  assigning meant whoever wired the next one would silently delete effort, or
  have effort delete theirs, depending only on which line ran last.
