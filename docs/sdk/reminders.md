---
type: Reference
title: Hidden reminders
description: The opt-in channel a host feeds with text the model reads before each request, how it is recorded, and what a source can see to decide its own cadence.
resource: packages/sdk/src/runtime/query/reminders.ts
tags: [sdk, context, query]
status: stable
generated: { by: process:claude-code, at: 2026-10-19T00:00:00Z }
---

# Hidden reminders

A host sometimes needs to tell the model something in the middle of a conversation: the mode changed, a list has been neglected, a rule still applies. The system prompt is the wrong place, because changing it re-keys the cached prefix of every later request. `QueryParams.reminders` is the right one.

```ts sketch
import { query, type ReminderSource } from '@namzu/sdk'

const reminders: ReminderSource = ({ messages, iteration }) =>
  messages.filter((m) => m.role === 'assistant').length >= 10
    ? ['You have not updated the task list for a while.']
    : undefined

query({ /* … */ reminders })
```

The kernel calls the source once at the start of every model request of a turn, except the closing one a limit forces. Each text it returns is appended to the conversation as a user-role message with provenance `{ type: 'runtime-context', kind: 'reminder' }` (`isReminderMessage` recognises it). It is part of the durable history, so:

- it is not operator input: `isOperatorUserMessage` says no, it is never the latest user request, and a host shows it as nothing, or as a labelled note in an export;
- it sits after what the model has just seen (the operator's message or the finished tool batch), so a request that carries one still starts with the same cached prefix;
- a source needs no counter of its own. `ReminderContext.messages` is the conversation as it stands, reminders included, so "how many assistant turns since I last spoke" is a scan. A compacted or resumed conversation simply starts counting again from what is left.

`ReminderContext` also names the session, the turn and the 1-based iteration. A source that throws has nothing to say for that request: the failure is logged and the turn goes on.

The channel is off unless a host passes `reminders`; a turn without one is unchanged. The CLI turns it on for the interactive terminal, where it carries [plan mode's reminders](../cli/plan-mode.md#reminders).
