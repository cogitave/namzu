---
'@namzu/sdk': minor
'@namzu/cli': minor
---

A credential turning over is now observable, and the doctor's vault check
can answer.

Rotation was invisible: a lapsed OAuth token was refreshed straight into
the CLI's file store, and the bus carried `vault_lookup` with no change
event — so no probe subscriber could see a credential replaced, and nothing
could answer "when did this last rotate".

`vault_credential_changed` joins the bus, dispatched through the same probe
registry `vault_lookup` already uses rather than a second one, which would
mean a subscriber that saw lookups and not rotations depending on which it
found. `kind` separates `set` from `rotated`, which is the distinction a
reader wants: a first write is configuration, a replacement is a credential
turning over. The event carries the credential's NAME and never its value —
a change event exists to be logged, forwarded and retained, which is
exactly what a secret must not be.

`FileCredentialProvider` makes the CLI's hardened store writable through
the seam. It adds no file logic of its own: the store already owns the `wx`
open, the `0600`, and the read-back that proves the mode landed, and a
second copy of that guarantee is the one that would drift.

The doctor's vault check answered `skipped` unconditionally with "no vault
auto-discovery in v1" — the same answer on every machine, forever, which is
the shape `a-check-that-cannot-fail` warns about. It now reports what the
registered providers describe, and returns `skipped` only when none is
registered. It calls `describe`, never `resolve`: this output is what an
operator pastes into an issue.
