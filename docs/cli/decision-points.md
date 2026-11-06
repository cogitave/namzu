---
type: Guide
title: Decision points
description: "decision.points: the places the CLI can ask the decision model a yes/no question beside its own rule, the off, shadow and on modes, the points (notify-worthy, memory-admit, skill-worthy), what is sent and what the decision log holds."
resource: packages/cli/src/integrations/decision/points.ts
tags: [cli, config, decision]
---

# Decision points

A decision point is one named yes/no question the CLI already answers with a rule.
With a [decision model](../sdk/decision.md) configured, the CLI can ask the model the
same question beside the rule. The model is advisory: a point never makes a turn fail
or wait, and with no answer in time the rule decides, as it did before.

```yaml
decision:
  provider: azure
  endpoint: https://<resource>.services.ai.azure.com
  deployment: <deployment>
  points:
    notify-worthy: shadow
```

`decision` is read only from your user and managed config, never from a project's file.

Everything here is a choice you make. With no `decision` block there is no model and
nothing is asked; with one, a point you do not name is `off`; and `NAMZU_NO_DECISION=1`
in the environment turns every use of the decision model off at once (these points, `model:
auto` routing and the `decide` tool), whatever the config says.

## Modes

| Mode | What happens |
|---|---|
| `off` | Nothing is asked. This is every point's mode until you name it, because a question carries text of the conversation to the decision service. |
| `shadow` | The model is asked and its answer is written to the log beside what the rule decided. Nothing else changes. This is how a point earns trust. |
| `on` | A confident answer (`P(true)` of 0.7 or more, or 0.3 or less) decides; anything else is the rule. |

A question is cut short, has its control characters removed, and is answered inside
1.5 seconds, or not at all.

## `notify-worthy`

Is this finished reply worth calling you back for? The rule is the length of the turn:
a turn that ran ten seconds or more ends with the [chime](terminal-design.md#the-turn-chime),
a shorter one is silent. Length says nothing about what the reply is: a four-second
answer that stops to ask which of two things to do is silent, and a long turn that ends
in "done" rings. With the point `on`, the model reads the last 1,200 characters of the
reply and a confident yes sounds a short reply, a confident no mutes a long one. A stop,
a failure and an approval always sound, whatever the model says. The reply tail is the
only text that leaves the machine.

## `memory-admit`

Is what this turn learned worth remembering? At settle the session writes one stored
memory for any turn whose compaction pass extracted a claim, which keeps whatever a turn
happened to learn: routine progress and facts the code already states fill the store, and
the model reads that store on every search. With the point `on`, the decision model reads
the task and the claims (requirements, decisions, discoveries, failures, environment) and a
confident no (`P(true)` of 0.3 or less) writes nothing; anything else, a failure included,
writes as before. It runs after the answer is settled, so it never delays a reply. A turn
with no claim asks nothing. The claims are the text that leaves the machine; file paths are
not sent.

## `skill-worthy`

Is this finished turn a procedure worth saving as a skill? The rule looks at the turn's
shape (six successful tool calls, two distinct tools, a clean tail) and cannot tell a
routine you will want again from a one-off that happened to take six calls. With the point
`on`, a proposal the rule already made is put to the decision model, and a confident no
(`P(true)` of 0.3 or less) withdraws it. The model never creates a proposal the rule did not
make, and nothing is saved either way. What is sent is your request (cut at 600
characters) and the names of the tools used; no tool arguments, results or file contents.

## The log

Every question is one line of `<NAMZU_HOME>/decision/points.jsonl` (rotated at a
megabyte): the time, the point, the mode, `p`, what the rule decided, how long the call
took, how it ended (`answered`, `timeout`, `error`) and the size of the question. It holds
no text of the conversation. To see how often the model and the rule agree:

```bash
jq -s 'map(select(.p != null)) | {asked: length, agree: (map(select((.p >= 0.5) == .rule)) | length)}' \
  ~/.namzu/decision/points.jsonl
```

Run a point in `shadow` for a while and read the disagreements before turning it `on`.
