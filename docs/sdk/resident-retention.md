---
type: Design
title: Resident retention and history
description: Bounded active agendas with immutable archival evidence, historical deduplication and preserved ancestry limits.
resource: packages/sdk/src/manager/resident/agenda.ts
tags: [sdk, agents, continuity, storage]
status: draft
---

# Resident retention and history

`DiskResidentAgenda.archive(expectedAgenda, ResidentArchiveRequest)` frees
active pursuit/message slots without deleting their immutable history. This
allows repeated authorized work beyond the active limits of 32 pursuits and
128 messages. It does not perform physical revision compaction or bound lifetime
disk usage.

The request explicitly lists `pursuitIds` and/or `messageIds`. At least one
unique known ID is required. Only complete/blocked pursuits and
acknowledged/cancelled messages can be removed. A remaining child must retain
its parent, and every remaining message must retain its pursuit. Archive a
terminal closed group together or remove its dependants first. Waiting/running
pursuits and pending/sending messages cannot be discarded through this API.

Archiving a child while retaining its parent increments the parent's optional
`retiredChildren` count. Proposal admission counts current children plus
retired children; archiving cannot reset the parent's lifetime child allowance.
The full removed child still retains its original ancestry in history.

The archive commit records one `archiveHead` revision pointer. Before/after
snapshots of that revision contain the removed records and the prior archive
pointer. New normal revisions preserve this pointer. Archive traversal skips
ordinary execution/control revisions and checks that each removal exactly
matches its predecessor, including terminal state and retained-child counts.
Missing, altered or cyclic archive history is refused, not interpreted as
permission to reuse old IDs.

`listArchived(ResidentArchiveListOptions)` returns a `ResidentArchivePage` with
`entries` and `nextBeforeRevision`. Each `ResidentArchiveEntry` has an archive
revision and its removed pursuits/messages. The default limit is eight archive
events, maximum 32; it does not mean eight individual records. Pass the returned
cursor as `beforeRevision` to continue. A null cursor ends the chain.

`readRevision(revision)` reads one authoritative immutable agenda commit,
validating its scope, schema, and filename/body revision. A missing revision
returns null. It does not reconstruct a nonexistent record from a legacy
projection, nor permit a rollback to overwrite history.

Proposal admission checks archived proposal IDs before its final revision CAS.
Message enqueue/settlement similarly checks archived message IDs. A matching
standalone enqueue can return its archived terminal message even when its
pursuit has also been removed. Changed immutable content or source claim under
the same ID is rejected. A competing archive or update invalidates the expected
snapshot; this cannot race into an unguarded enqueue.

Exact historical deduplication costs O(archive events), reading two bounded
snapshots at a time. There is no growing tombstone array in the active snapshot
and no second mutable archive index to synchronize. This trades lookup speed
for a small correctness-oriented implementation. A future indexed backend and
physical retention scheme must preserve these identity/ancestry contracts.
Do not manually remove immutable revisions: the archive, rollback and stale
writer fences depend on them. Trusted local filesystem and power-loss limits
remain those of the [resident store](resident-agents.md).

Agenda schema 4 added archival and [learning](resident-learning.md); schema 5
adds the [durable pause generation](resident-agents.md). Schemas 1–4 read without
invented history or learned state; new writes use schema 5.
Earlier writers refuse it to avoid silently stripping these fields. No existing
host starts archival automatically, and no CLI/session history is removed.

Unit tests fill and reuse the pursuit capacity, preserve historical message and
proposal deduplication, enforce closed groups and lifetime child bounds, page
multiple archive events, and refuse stale or damaged history. A process test
races two archive operations against one snapshot, verifies one commit wins,
then reopens in a new process and refuses a duplicate send after its active
pursuit/message have been removed. The full
`research/resident/lifecycle.mjs` experiment joins these controls with learned
context, continuation, rollback and local delivery.
