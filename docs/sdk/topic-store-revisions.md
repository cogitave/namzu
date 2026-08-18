---
uid: namzu.sdk.topic-store-revisions
title: Durable topic revisions and shared-store upgrades
description: Reference for exact topic-state and objective revisions, immutable disk commits, crash behavior, tenant isolation, filesystem requirements, and safe upgrades of a shared store.
type: Reference
diataxis: reference
owner: cogitave/namzu
status: active
timestamp: 2026-08-18T00:00:00Z
lastReviewed: 2026-08-18
resource: packages/sdk/src/store/kv/revision-record-store.ts
tags: [sdk, storage, topics, concurrency]
---

# Durable topic revisions and shared-store upgrades

`TopicStateStore` and `TopicObjectiveStore` use an exact revision as their
compare-and-set boundary. A mutation presented with revision N succeeds only
when N is still current, and the committed record becomes revision N+1. When
writers race, exactly one commits; the others reject with the store's stale or
already-exists error after observing the durable winner.

The in-memory implementations make the read, domain checks and map update in
one JavaScript turn. The disk implementations also arbitrate separate Node.js
processes. They write a complete schema-stamped record to a private scratch
file, then publish the canonical revision name with an exclusive hard link.
Only one process can create that name.

## Disk layout and crash boundary

For a record whose public id is `obj_1`, the objective store uses this shape:

```text
objectives/
├── obj_1.json                    compatibility projection
└── .revisions/
    └── obj_1/
        ├── 1.json                immutable commit
        └── 2.json                immutable commit
```

The immutable revision file is the commit. The single-file record is a
best-effort compatibility projection for the previous store format and is
updated only after the commit. A crash between those writes can therefore
leave the projection behind the immutable head; current readers accept that
state and use the head. They refuse these states as damaged or
mixed-version data:

- the projection is ahead of the immutable head;
- the projection and head claim one revision but contain different values;
- a revision filename and its record body disagree.

Revision files are not deleted. A delayed writer must continue to collide with
the revision name it originally tried to claim; deleting that name would let
the stale mutation report success. Operators should account for this
append-only storage cost when choosing the store root.

Public ids are encoded injectively for immutable revision directories so path
syntax cannot leave the configured root. A previous single-file name is still
read directly when the id was already one path component, preserving dotted,
spaced and Unicode ids during migration. Separators and NUL are encoded.
Listing stores decode and validate the immutable directory names themselves;
they do not depend on the best-effort projection being present. A store may
also suppress a legacy projection when the old filename scheme would map two
logical keys to one path.

The revision record helper takes a domain-specific revision selector. Topic
state and topic objectives use their public revision directly. Other stores may
use a private monotonic storage sequence when their public identity can restart
— session goals, for example, begin a fresh public goal at revision 1 after a
clear tombstone while their immutable record sequence continues forward.

## Filesystem requirement

The disk stores require complete-file writes and exclusive hard-link creation
within one filesystem. If the filesystem reports that hard links are
unsupported, the operation rejects with `capability_unavailable`; it does not
fall back to a read-check-replace sequence that can admit two writers.

## Shared-root upgrade procedure

The previous store implementation knows only the compatibility projection and
does not participate in immutable revision commits. It cannot safely write at
the same time as the current implementation.

For a root shared by more than one process:

1. Stop every process using the old SDK version.
2. Upgrade all processes that write the root.
3. Start the upgraded processes.

Do not perform a rolling upgrade with mixed SDK writer versions. Existing
single-file records are read forward automatically after the old writers have
stopped. A current reader detects durable projection/head disagreement, but no
new protocol can make an already-running old binary honor an exclusion rule it
does not know.

## Caller constraints

- `maxRounds` must be a positive safe integer. Fractions, infinities, `NaN`,
  zero and unsafe integers are rejected before an objective is created.
- A read for another tenant returns `null` and does not confirm that a hidden
  record exists.
- A mutation aimed at another tenant rejects with `TenantIsolationError`.
  Treating the hidden record as absent would let the caller overwrite it.
- After a stale-revision error, read the record again and decide whether the
  winning value makes the intended mutation unnecessary before retrying.
