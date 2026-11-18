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

## When a message was sent

A person's message carries one line saying when it was sent, in local time with the zone: `[Sent at 22:41, UTC+03:00 Europe/Istanbul]`. The date is not in it; the environment note says it.

From the second message on, the line is added only when the gap from the person's previous message is 5 minutes or more, and then it states the gap in plain words rather than leaving a model to subtract two clock readings: `[Sent 2 h 15 min after the previous message, at 00:56, UTC+03:00 Europe/Istanbul]`. A quicker follow-up carries no line.

The line is written once, with the message, and stored beside it (`UserMessage.timeNote`, [Pasted text](../sdk/pasted-text.md) describes the other stored field). The model request puts it in front of the message; the message itself is what the person typed, so the transcript, a resumed conversation, an export and the Desktop bubble show no line, and a resume sends the same bytes. After a compaction that removed the person's earlier messages, the next message reads as a first one and says its time and zone again.

The terminal and Desktop messages carry it. Sub-agents' prompts, goal rounds, peer messages and host notices do not, and neither does `namzu exec`: it sends one prompt in a script, where the model has no earlier message to be far from.

## Tool results that name the next move

Some results say what to do next because a wrong next move was common in the benchmark runs: a read-back after a write, a re-read of a file a refusal had just handed over, a guessed second path after "no such file", a write over a file nobody read, a search re-asked with an inline flag. The wording and the counts are in [File tools](../sdk/file-tool-limits.md#edit-and-write). They are clauses on results, not on tool descriptions, so they cost nothing until the moment they apply.

## The closing note

The working rules end with one rule: when the model changed something, it closes with what changed, what was verified and what is left, and for a question the reply is the answer. The config key `closingSummary` (default `true`; Desktop Settings > Agent > *Summary and next steps*) leaves that one rule out of the working rules of conversations started after the change, and nothing else in them changes; with the key absent or `true` the prompt is byte for byte what it was. It is a rule the model follows, not a block the app draws, so a small model may still write one, and the setting adds no model request. A delegated agent reads its own final-report rule and is unaffected, and so are the other places a reply is shaped (the done gate, the turn-end reminders).
