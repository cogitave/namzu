---
'@namzu/sdk': minor
---

Persisted state carries a schema version, and a record from the future is
refused instead of half-read.

Every read from disk was `JSON.parse(raw) as T` — an unchecked cast with no
idea which version of the shape it was looking at. Three things followed,
all of them silent:

- A record written by an **older** build was read as the current shape.
  Fields added since arrived as `undefined` and flowed into the runtime as
  though they had been there.
- A record written by a **newer** build was read by an older one, which
  understood some fields and dropped the rest. Write it back and the rest
  are gone — the only one of these that destroys data.
- None of it produced an error, a warning, or a log line. A resumed session
  that quietly lost half its state looked exactly like one that never had
  it.

The version is stamped as a field on the record rather than wrapping it in
an envelope, so **every file already on disk stays readable**: a record with
no stamp *is* version 1, which is exactly what those files are.

- `defineSchema` / `stamp` / `migrate` in `store/schema.ts`, adopted by the
  session, thread, run, task and memory disk stores. Each store versions its
  on-disk format as a unit, so no call site carries schema plumbing.
- A record from a version this build does not understand throws
  `SchemaVersionError` naming what it found and what is supported. Refusing
  is recoverable by upgrading; a partial read that gets written back is not.
- A gap in the migration chain is rejected when the schema is **declared**,
  not when a stale file finally shows up — a gap found at read time is found
  in production, by a user whose session will not open.
- Each line of the append-only message log carries its own stamp: such a log
  is written by many builds over its lifetime and its lines can legitimately
  differ in version. A line the build cannot read is refused rather than
  skipped, because silently dropping one hands the model a conversation with
  a hole in it.

Known limitation, stated rather than papered over: a file whose top level is
an array has nowhere to put a stamp that survives `JSON.stringify`, so it
stays unversioned. A store that needs to migrate one has to move it under an
object first.
