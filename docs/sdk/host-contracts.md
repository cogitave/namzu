---
type: Reference
title: Host contracts of a turn
description: What the kernel guarantees a host about carried history, attachment cancellation, project instructions, where a session is stored and topic lifecycle.
resource: packages/sdk/src/runtime/query
tags: [sdk, host, history, attachments, sessions, topics]
status: stable
---

# Host contracts of a turn

These guarantees used to be described on the `@namzu/sdk` package page. They
are kept here unchanged, for hosts that embed the kernel.

## Carried history is checked before the provider sees it

Before a provider receives carried history, the kernel validates tool-call
chronology. Orphaned and displaced results are removed, abandoned calls receive
an explicit unknown-outcome error result, and duplicate call ids fail closed.
Durable approval or crash-resume authority is resolved first so an owned call
is completed exactly once. Hosts receive `message_history_repaired` with source
and counts before the model call; conversation and tool content stay out of the
event.

## Attachments and cancellation

Stored image and document references are materialized under the turn's caller
signal before provider work starts. A pre-cancelled turn performs no attachment
store I/O; cancellation also settles the turn when a custom or remote store
ignores the signal, while retaining the unresolved references in its durable
message record. `AttachmentStore.get` receives an optional
`AttachmentOperationOptions` so implementations can stop their own I/O. The
caller keeps ownership of its controller, and a late store result is never
published into a cancelled turn. `resumeSession` carries its already-selected
checkpoint snapshot into the same boundary, so cancellation neither rereads a
non-cooperative checkpoint backend nor replaces prior history, usage, or a new
queued reference with an incomplete snapshot. The selected checkpoint also
carries its durable trace parent into the cancelled turn, preserving one
cross-process timeline without a second checkpoint read.

## Project instructions

Hosts that discover scoped repository policy can supply a
`ProjectInstructionContext` to `query`, `runAgent`, `QueryAgent`, or
`SupervisorAgent`. Its first-request snapshot is structurally tagged and
retained; completed registry calls, including nested dispatch, can publish a
replacement immediately after the complete tool-result batch. Each callback
receives the turn signal and the exact accepted message prefix; each returned
snapshot is committed before the next observation starts, so cancellation can
discard an unfinished suffix without losing accepted policy state. This
channel does not create a human continuation, so a terminal tool or stop
predicate cannot strand the update. Canonical project-relative `AGENTS.md`
provenance survives compaction and lets a reconstructed host re-read disk
authority rather than trusting persisted policy text.

Compaction treats these snapshots, step context and reminders as runtime text,
not as the operator's words: they never become the summary's task or a
requirement, and the summary check's excerpt leaves them out. The snapshot is
retained whole, so a compacted history holds it once, and the next turn
reads it fresh.

The snapshot keeps one place in a conversation. When a new turn's
`prepareInitialSnapshot` returns what the history already holds, the held copy
stays where it landed and nothing is sent again, so the provider's cache covers
the history after it. A changed snapshot is sent once, at the tail just before
the turn's new user message, and replaces the old copy: the latest snapshot is
always the complete policy, so a rule that was removed stops applying. The snapshot also tells the model that project
rules win over Namzu's default style and workflow, and never over safety or
permission rules.

## Where a session is stored

The `QueryAgent` configuration and the compatibility `SupervisorAgent` configuration also accept
`paths`, a `SessionPaths`. Supplying one puts the session log, its child
sessions, checkpoints, token ledger and task state under that root instead of
`resolveNamzuHome()`. A project id is minted once per working directory into
`projects/<slug>/project.json`; two processes that open the same directory at
the same moment adopt the same id.

## Topics

`TopicManager` is the lifecycle authority for the durable subject above a
session. Supply it to agent and handoff dependencies as `topicManager`; spawn
and handoff then share the same archived-topic gate. Hosts can distinguish
`TopicArchivedError`, `TopicNotEmptyError`, and `StaleTopicError` directly from
the package root, and each carries `details.topicId`.
