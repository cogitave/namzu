---
'@namzu/sdk': minor
'@namzu/cli': minor
---

Nothing stored a per-message judgment, so every consumer had to invent its
own side table to answer the most basic question there is — was that answer
any good.

`MessageFeedbackStore` records a `'good' | 'bad'` rating and an optional
note per `{ runId, messageId }`, in memory or on disk. `rating` is a closed
union rather than a number or a free string: a 1–5 scale invites a mean
nobody can interpret across raters, and widening the union later is now a
deliberate major rather than an accident.

Writes are compare-and-set on a per-record `ownerVersion`, throwing
`StaleFeedbackError` with both the expected and the actual version. The
disk store's first write uses an exclusive create, so two raters who each
read "no feedback yet" cannot both land — a read-then-write is not atomic,
and a rating is exactly the kind of value where last-write-wins loses
information nobody notices is gone.

A rating aimed at a `messageId` that appears in no event of the named run
is refused with `UnknownMessageError` and nothing is written. A row
pointing at a message nobody can find is unreviewable and
indistinguishable from a real one. A disk store built without a run
directory to validate against refuses every write rather than accepting
everything it cannot check.

Both implementations run one conformance suite, which found a real
divergence between them the day it was written.

In the CLI, `/feedback good|bad [note]` rates the last answer. With no
answer yet it refuses rather than writing against a synthesized id. The
kernel's `messageId` and `runId` now travel across the CLI's event seam,
which previously dropped both.
