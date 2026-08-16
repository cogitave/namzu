---
'@namzu/sdk': minor
'@namzu/cli': patch
---

`CredentialProvider` is a seam a host can implement to say where a
credential comes from, with `EnvCredentialProvider` shipped in the box.

Every LLM-provider credential lookup lived in `@namzu/cli`, which walks its
own provider registry and reads `process.env` directly. A host embedding the
SDK alone had no way to plug in an env- or file-backed source short of
reimplementing `CredentialVault` — a connector-scoped interface that asks a
different question, holds a whole `AuthConfig` per connector, and has one
in-process implementation with no notion of writability.

`describe()` never carries the value. "Does this exist" is asked in places a
secret must not travel to — a doctor readout, a picker, a log line — and a
description that carried one would leak on every one of them while looking
like metadata.

`EnvCredentialProvider` is read-only and says so: `set` and `unset` throw a
named error pointing at a writable alternative, rather than accepting a
write and dropping it. A `set` on `process.env` changes one map in one
process and vanishes with it, while the caller is told it worked.

The credential key-name vocabulary moves to `constants/credential-env-keys.ts`,
a leaf with no imports beside `secret-patterns.ts` — that file matches
credential VALUES, this one the names they are carried under. The host-bash
environment scrub and the credential seam now read the same table, and
`isCredentialEnvKey` is exported so a host with its own provider registry can
assert its variables are ones the scrub will withhold. A name in one table
and not the other means a variable the CLI reads an API key from and the
scrub hands to a shell command.

CLI discovery goes through the seam with identical results.
