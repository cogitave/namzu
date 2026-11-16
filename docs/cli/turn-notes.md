---
type: Reference
title: Notes the model reads as a turn goes
description: The quiet-stretch nudge, the time line on a message, and the clauses some tool results carry, with where each is off and the progressNudge key.
resource: packages/cli/src/reminders/quiet-stretch.ts
tags: [cli, reminders, context, config]
status: stable
generated: { by: process:claude-code, at: 2026-11-16T00:00:00Z }
---

# Notes the model reads as a turn goes

The system prompt is the wrong place for guidance that applies only sometimes: it is read on every request and changing it re-keys the cache. These notes travel with the moment they are for, and cost nothing when it does not come.

## The quiet-stretch nudge

On a screen a person watches live, a model may work for minutes and many tool calls without one visible sentence. The working doctrine already asks for a few words after a long stretch and small models do not do it, so the runtime asks once, when it is true.

It is a hidden reminder (`<system-reminder kind="quiet-stretch">`, [Hidden reminders](../sdk/reminders.md)) added before a model request when both hold:

- at least 90 seconds of work have passed, and
- at least 6 tool calls have been made

since the person last saw text from the assistant, or since their own message. It asks for one sentence on what is being done and found so far, in the same response as the next tool call, and then to carry on. Time spent waiting on the person (a permission prompt, a question) does not count, and neither does the time between turns. It is said once per stretch: visible assistant text ends the stretch, and a new one begins. It never comes on the first request after a message, and a model that answers it with a sentence and a tool call is not stopped by it; the turn ends only when the model ends it.

The 90 seconds and 6 calls come from measurement. Across 168 benchmark runs on the two small models, the longest quiet stretch of a run had a median of 8 seconds and a maximum of 59; a third of the runs passed 6 calls in under a minute, so calls alone cannot tell a short task from a long one and time can. 90 seconds sits above the longest of them: none of those runs would have been nudged.

It is on where a person watches live: the terminal and the Desktop application. It is off for sub-agents, `namzu exec --json`, scheduled runs, Pals and `namzu drain`. `namzu exec` in text mode is not counted as watched, because it often runs unattended; `progressNudge.mode: on` turns it on there.

### The `progressNudge` key

```yaml
progressNudge:
  mode: auto        # auto (default) | on | off
  afterSeconds: 90  # whole seconds, 1 or more
  afterCalls: 6     # whole number, 1 or more
```

- `mode: auto` nudges the terminal and Desktop only. `on` also nudges `namzu exec` in text mode. `off` never nudges.
- `afterSeconds` and `afterCalls` set the stretch.
- Files merge key by key; the last file to set a field wins. The environment cannot set it. A bad value is refused with the key's path, not dropped.
- Desktop shows the three fields in Settings, under Agent.
