---
type: Reference
title: Ids
description: Kernel id prefixes, checked constructors, portable suffixes, and storage validation.
resource: packages/sdk/src/utils/id.ts
tags: [sdk, ids, storage]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-04T00:00:00Z }
---

# Ids

Every id the kernel mints is a prefix, an underscore and a random suffix over `[0-9a-z]`: `run_…`, `ses_…`, `prj_…`, `top_…`, `tnt_…`, and the rest listed in `types/ids`. The prefix is part of the type: `RunId` is a branded `` `run_${string}` ``, so a session id does not compile where a run id is expected, and `generateRunId()` cannot mint anything but a `run_` value.

Checked constructors also accept established custom suffixes containing ASCII letters, digits, underscores and hyphens (`[A-Za-z0-9_-]+`). The suffix must be nonempty. `run_Selected-A_1` is accepted unchanged; `run_`, `run_../outside`, whitespace, periods, colons and Unicode suffixes are rejected. Constructors never trim, lowercase or rewrite ids.

## Three ways to hold one

- **Mint** with the factory for the type: `generateRunId()`, `generateSessionId()`, and so on. This is the only way a new id comes into being.
- **Check** a string from outside — a log line, a URL, a file — with the constructor for the type: `asRunId(value)` returns the same string typed, or throws `InvalidIdError` naming the expected prefix and suffix rules. The older `parse*Id` functions apply the same validation with a plain `Error` and are deprecated; they leave in the next major.
- **Fixtures** in tests use `test-support/ids` so a test's ids are readable and still typed.

A cast (`value as RunId`) asserts without checking and is the one thing this design exists to make unnecessary.

Storage boundaries must validate ids again because a JavaScript caller, a type assertion or a persisted record can bypass the constructor. `DiskSessionStore` validates project, session and sub-session lookup ids and a caller-chosen session id before using them. A portable id segment does not establish tenant ownership or protect against filesystem symlinks; those are separate storage concerns.

The exported `ProjectIdSchema`, `RunIdSchema` and `MessageIdSchema` describe factory-style lowercase alphanumeric suffixes. They remain narrower than the checked constructors, which preserve safe custom ids used by existing callers.

Provider-issued tool-use ids are correlation strings and retain their original spelling. User-question and tool-pause requests carry those strings in `questionId`; their checkpoint ids come from the durable recorder or, when no checkpoint was recorded, a separate `generateCheckpointId()` call. A host should match an answer to `questionId`, without deriving it from the checkpoint id.

## Upgrading custom ids

Earlier constructors checked only the prefix and accepted empty or arbitrary suffixes. Those values now fail validation, including old message-feedback records with punctuation, whitespace or Unicode ids. Existing files are left unchanged. Export affected records with the previous SDK before upgrading and remap their ids together with every referring record, or retain the previous SDK for that data. Ids produced by the factories and safe custom ids need no migration.

## One prefix, no rewriting

A persisted record's id has exactly one valid prefix, and a reader that meets another refuses with `RetiredIdPrefixError` rather than rewriting it. The kernel used to accept the pre-0.2 `thd_` container prefix on read, coerce it to `top_` or `prj_`, re-lay the filesystem at boot and record a migration marker; that machinery is gone. Records written by namzu before 0.2 are not read by this version: open them with a 0.x namzu that migrates them, or start fresh.

Schema versions are a different matter and stay: a `version: 1` run state or an unstamped session record is still read and its field names brought forward. What is no longer done is guessing what a value meant.

## A session id chosen ahead

A host may pass `id` in `CreateSessionParams` so a conversation is created under an id the host already showed, logged or handed to a hook. The store refuses an id it already holds. The interactive CLI does this: the conversation's id is chosen when the session opens and the record is written under it at first durable use, so nothing that saw the id earlier is later wrong.

## Tenant

The kernel files every project under a tenant and never invents one. The CLI mints one per installation (`~/.namzu/identity.json`) and a topic per project; the placeholder `UNKNOWN_TENANT_ID` that stood in for both is gone.
