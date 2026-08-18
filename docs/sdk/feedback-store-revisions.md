---
uid: namzu.sdk.feedback-store-revisions
title: Durable message-feedback revisions
description: Reference for exact message-feedback compare-and-set updates, immutable disk commits, legacy projection handling, filesystem requirements, safe identifiers, and shared-root upgrades.
type: Reference
diataxis: reference
owner: cogitave/namzu
status: active
timestamp: 2026-08-18T00:00:00Z
lastReviewed: 2026-08-18
resource: packages/sdk/src/store/feedback/disk.ts
tags: [sdk, storage, feedback, concurrency]
---

# Durable message-feedback revisions

`MessageFeedbackStore.putMessageFeedback` is an exact compare-and-set write.
The first write presents `expectedVersion: 0` and commits `ownerVersion: 1`.
Every update presents the version it read and commits the next integer. If
several writers present the same version, exactly one succeeds; the others
receive `StaleFeedbackError` with the durable winner's version.

The in-memory store performs its read, check, and map update in one JavaScript
turn. `DiskMessageFeedbackStore` also arbitrates separate processes. It writes
a complete schema-stamped body to a private scratch file and publishes the
revision name with an exclusive hard link.

## Disk layout and listing

For message `msg_1` in run `run_1`, the disk store uses:

```text
feedback/
└── run_1/
    ├── msg_1.json                 compatibility projection
    └── .revisions/
        └── msg_1/
            ├── 1.json             immutable commit
            └── 2.json             immutable commit
```

The immutable file is the commit. The single-file record is the previous
format and remains a checked, best-effort projection. A crash after the hard
link but before projection replacement therefore does not undo a successful
write.

Feedback is read through a listing rather than by message id. The listing
unions message ids found in old projection files with ids decoded from current
revision directories, then resolves every value through its immutable head.
This makes an immutable-only first commit visible and returns one record per
message in stable message-id order.

The old projection filename replaced punctuation with underscores and was not
injective. Current writers still read such a file forward, but they do not
publish a new projection for an id whose old filename could collide with
another id. Those records live only in their injectively encoded revision
directories. Generated `msg_*` ids retain the old projection path.

Readers accept a projection behind the immutable head. They refuse a
projection ahead of the head, an equal-version projection with different
content, a revision filename whose body reports another owner version, or a
body filed under another run/message key.

## Identifier and existence boundaries

Public operations validate the `run_*` and `msg_*` prefixes at runtime. A
TypeScript brand can still be bypassed by a type assertion and does not exist
for JavaScript callers. Run ids are resolved through one injective filesystem
segment before either the feedback root or transcript root is joined, so `/`,
`\`, and NUL cannot redirect validation or persistence outside those roots.

By default, a write also requires `runsDir` and verifies that the named run's
event log contains the message id. A host may inject its own
`MessageExistenceCheck`, but id validation still happens before that callback.
Omitting both `runsDir` and a checker refuses every write.

## Filesystem and upgrade requirements

The disk store requires complete-file writes and exclusive hard-link creation
within one filesystem. An unsupported hard link rejects with
`capability_unavailable`; the store does not degrade to read-check-replace.
Revision files are append-only so a delayed stale writer can never reuse an
old revision name.

The previous implementation does not know about immutable revision commits.
For a shared feedback root, stop every process using the old SDK, upgrade all
writers, and only then start the new processes. Mixed-version rolling writers
cannot be made compare-and-set safe because the already-running old binary
does not participate in the new commit protocol.
