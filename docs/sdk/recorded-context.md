---
type: Reference
title: Recorded turn context
description: How a step keeps repository state, recalled memory, conversation evidence, file evidence and finished delegated work in the conversation as entries that are only ever added, so each request begins with the whole of the one before it.
resource: packages/sdk/src/runtime/query/iteration/recorded-context.ts
tags: [sdk, context, caching, providers, runtime]
status: stable
---

# Recorded turn context

Request-only [step context](step-context.md) is gone after the request that
carried it. A caching provider reads back the longest prefix a request shares
with the one before, so anything that changed ahead of the operator's message
or the tool loop made the provider read the previous turn's content again at
full price. Recorded context is the other channel: text a step wants the model
to keep is appended to the conversation as an entry, once, and is never edited,
moved or removed by the step that wrote it.

## What an entry is

`PrepareStepResult.recordedContext` is a list of `{ key, text }` items. After
the preparation stages run, the loop appends one history entry per item whose
text is not empty and differs from the last entry under that key. The entry
is a user-role message with source
`{ type: 'runtime-context', kind: 'turn-context', key }` and goes after
whatever the history ends with: the operator's message on the first call of a
turn, the tool results on later calls. A key is lowercase words joined by
hyphens (at most `MAX_TURN_CONTEXT_KEY_LENGTH` characters); an item with
another key is skipped and logged.

The text is frozen when it is appended. It opens with a line saying it is
recorded context the host generated, not a new request from the operator, which
key it is filed under and when it was written. The first entry under a key adds
that a later entry under the same key adds to or replaces what it says; a later
entry leaves that sentence out, since the conversation already holds it
(`createTurnContextEntry(key, text, at, { later: true })`). The producers do the
same with their own reading rules: the first memory, evidence and repository
entry carries the full rules, a later one a short line (and, for evidence, the
fields as before), and a conversation whose earlier entries were compacted away
gets the full rules again. The first file-evidence entry names `bodyInCall`,
`editsInCalls` and `observedFingerprint`, and every owned-work entry names
`taskId`, `turnStatus`, `stopReason` and `resultDelivery`, each once in plain
words.

An entry is not an operator message and not retained: compaction drops it with
the history around it, like any older message. It is never shown to a person
in the transcript or in an export, `isTurnContextEntry(message)` tells it apart,
and `turnContextKey(message)` reads its key.

A step reads what it already recorded with `turnContextEntries(messages, key)`
(oldest first, the text after the header line), using the `messages` its
`PrepareStepContext` carries, and says only what is new. Because "already said"
is read from the history, resume, fork and rewind need no extra state, and a
compaction that drops the entries makes the step say its piece in full once
more.

```ts
import { type PrepareStep, turnContextEntries } from '@namzu/sdk'

export const branchName: PrepareStep = ({ messages }) => {
  const said = turnContextEntries(messages, 'branch')
  return said.length === 0
    ? { recordedContext: [{ key: 'branch', text: 'Working on branch main.' }] }
    : {}
}
```

Recorded context is the channel for facts that hold until something changes
them. What is true only for one request (the tasks still running, a
status note, the inventory) stays request-only `context` and goes at the end
of the request, after the history.

## What the kernel and the CLI record

| Key | Written by | First time | Later |
|---|---|---|---|
| `repository` | the CLI | the working tree status and recent commits | a short entry of what changed (files now listed, no longer listed, new commits); nothing when unchanged. The text says the snapshot does not update and that `git status` shows the present state |
| `memory` | `createMemoryRecallStep({ record: true })` | the records selected | only records whose `id` and `updatedAt` no earlier entry carries; nothing once the entries hold `sessionMaxChars` (24,000 by default), after which the model reads records with `read_memory` |
| `evidence` | `createEvidenceRecallStep({ record: true })` | the passages found for the prompt | only passages whose address no earlier entry carries; past `sessionMaxChars` (24,000) an entry names the addresses of further relevant records for the conversation-history tools to open. Notes about the search itself stay request-only |
| `file-evidence` | the loop | references to complete file bodies visible in the history | entries that are new or changed, and one `No longer holds:` line for paths whose earlier entry no longer holds, since an earlier entry is never edited |
| `saved-agents` | the CLI | the agents earlier turns delegated to (session id, what each was asked, status), with the rules for reading them | only an agent that is new or whose status changed; nothing when the listing is as the entries say |
| `owned-work` | the loop | none: the result of the call that launched a task already told the model | one entry per owned task that reaches a terminal state, once |

`record` on the two SDK recall steps defaults to `false`: with it off a step
behaves exactly as before and offers request-only context. The CLI turns it on.
The entries a conversation holds count against `sessionMaxChars` by their
length, so a compaction that drops them frees the budget.

## Placement and caching

A request begins with the history of the one before it, entries included, so a
caching driver keeps its breakpoint after the last history message. The
Anthropic, Bedrock, OpenRouter and Zen drivers end the cached prefix before the
first trailing `step-context` message only; a `turn-context` entry is ordinary
history to them and the breakpoint falls on or after it. Request-only blocks are
placed again after the whole history on every call (see
[step context](step-context.md#where-the-per-turn-blocks-sit)), so on every call
of a turn the breakpoint lands on the last history message. Entries the loop has
just recorded go ahead of them. Provider packages need no change.

What the entries cost is bounded by the producers. Over a fifty-turn
conversation with fresh evidence and memory each turn and nothing compacted, the
entries together hold about 68,000 characters (about 17,000 tokens at four
characters a token); the repository delta is about 460 characters and a pointer
to further records about 320. A deleted memory record is not retracted: an entry
that already carried it keeps saying it until a compaction drops the entry, and
the model can see the current record with `read_memory`.

Entries go after the operator's message, not before it: inserting one ahead
of a message already in the log would put the live history out of log order and
make the recorder write a compaction record on every turn. The model therefore
reads the operator's message before the entries, not last.

## Sessions, resume, fork and rewind

An entry is stored as an ordinary `message` record with the rendered text, so
replay is byte-stable even if the wording changes later. A session written by a
build that records context cannot be read by an earlier build, which rejects
the unknown message kind.

- **Resume** restores the entries with the rest of the history; the first
  request after it begins with what the interrupted one held, and a step that
  reads its entries does not say them again.
- **Fork** seeds the new session with the entries.
- **Rewind** cuts the entries after the chosen prompt with it and keeps those
  before it, so the step offers again what the cut entries had said. Position
  counts include entries on both sides (a checkpoint's prompt position and the
  list of prompts); a checkpoint written before entries existed is placed by the
  prompt's words.
- **Compaction** sheds entries with the history around them. The summary does
  not quote them as facts, and the search index does not store them as things
  said in the session, so a search does not find an earlier recall.
- **Sub-agents** run their own history with no producers; the parent's entries
  are not copied.

Entries carry untrusted text (repository names, stored memory, quoted passages)
for longer than a request: from the call that wrote them to the next
compaction, and across a resume. Each producer wraps its text as data, and no
entry is built from the instructions of an earlier entry.

## Upgrading

`'turn-context'` is a new member of `RUNTIME_CONTEXT_MESSAGE_KINDS` and of the
`RuntimeContextMessageKind` union, so an exhaustive `switch` over the kind
needs a case. `RuntimeContextMessageSource` has an optional `key`.
