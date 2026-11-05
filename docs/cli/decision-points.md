---
type: Guide
title: Decision points
description: "decision.points: the places the CLI can ask the decision model a yes/no question beside its own rule, the off, shadow and on modes, the first point (notify-worthy), what is sent and what the decision log holds."
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
