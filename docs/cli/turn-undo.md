---
type: Reference
title: Turn undo
description: The durable, turn-keyed file history behind undo and /restore, and the plan that decides, per file, what undoing a turn may write — what is stored, how long it lives, and what is never overwritten.
resource: packages/cli/src/checkpoints/undo-plan.ts
tags: [cli, files, safety, undo]
status: draft
generated: { by: human:bahadirarda, at: 2026-10-07T00:00:00Z }
---

# Turn undo

The file history that [`/restore`](file-checkpoints.md) uses is a durable record, keyed by the journal's `TurnId`, of every file the `edit` and `write` tools changed: the file as it was before the call and as it was after. This page describes the record and the plan that reads it. `/restore N` runs this plan for turn N and every later turn, newest first, and applies it without a conflict resolution, so every conflict is left as it is; the Desktop host reaches the same plan through the [ACP methods](#acp-methods) below.

## What is stored

Under `<session-id>/file-history/` in the conversation's directory:

- `turns/<turnId>.json`, one manifest per turn: its sequence number, the prompt that began it, a status (`applied`, `undone` or `partially_undone`), one entry per path, the paths it could not cover with a reason, and whether a shell command ran in it.
- `blobs/<sha256>`, the file bodies, named by their content so two turns share one copy.

One entry per path per turn: the first call's before state, the last call's after state. An entry is `pending` from the moment a call starts until it settles; a crash can leave one pending. Every write is a temporary file, an fsync and a rename.

A session ending **releases** the history from memory and deletes nothing. It is removed when its conversation is deleted, by retention, or never.

## On open

The history is read when a conversation is opened. A `pending` entry is settled by looking at the file: still as it was before means the call never wrote and the entry is dropped; anything else is recorded as the call's result. A body that is missing makes its entry unavailable for undo and nothing else. A manifest this reader does not understand is ignored.

## Retention

Applied when a conversation is opened, oldest turn first:

- a turn expires 30 days after its last edit;
- while the bodies the live turns name total more than 512 MiB, the oldest live turn expires.

An expired turn keeps its manifest, marked `pruned`, and loses the bodies nothing else needs; undo of it reports that it has expired. These are defaults of the store; no configuration key sets them yet.

## The plan

`planUndo` is a pure function: manifests and the disk's current state in, one action per file out. A preview and an apply use the same function, and the plan carries a token over what it saw, so an apply of a plan the operator did not preview is refused and re-planned.

Per file, with `K` the turn being undone:

| The disk holds | Action |
|---|---|
| a later, still-standing turn changed the file and started from what `K` left | conflict, `later-reply` (undone with it only on request, newest first) |
| what `K` left | restore its before body, or remove the file if `K` created it |
| what `K` started from (or nothing, for a created file) | nothing to do; this is what makes a rerun safe |
| the before body is missing | conflict, `unavailable`; nothing is written |
| a symlink, or a path that now leaves the project | conflict, `symlink` or `outside-cwd` |
| anything else, a changed mode included | conflict, `drifted` |

A conflict is skipped. The only way past a `drifted` one is to restore anyway, which first saves the file as it is now as a body recorded in the turn's manifest. A created file that is no longer what the turn wrote is never removed.

An apply re-reads each file immediately before writing it and leaves it alone if it moved since the plan. It is not all-or-nothing: what was restored, skipped and failed is reported, the turn becomes `partially_undone`, and running it again finishes the rest. A body is checked against its hash before it is written over anything.

## ACP methods

`namzu acp --desktop` registers three extension methods. A client detects support by finding all three in the `extensions` list of the `initialize` result, exactly as it does for Retry; an older CLI lacks them and the client hides the button.

| Method | Request and result |
| --- | --- |
| `namzu/turns/undo-status` | `{sessionId, turnIds?}` returns `{turns: [{turnId, status, files, added, removed, uncoveredShell, skipped}]}`. `status` is `applied`, `undone`, `partially_undone`, `none` (the reply changed nothing covered, or the id is unknown) or `expired`. Reads manifests only, never the disk, so it is cheap on open; without `turnIds` it lists every reply the history knows. |
| `namzu/turns/undo-preview` | `{sessionId, turnId, alsoUndoLater?}` returns `{turnId, status, planToken, files: [{turnId, path, rel, action, reason?, blockedBy?}], skipped, uncoveredShell, laterTurnsOnSameFiles}`. Hashes the disk, writes nothing. `action` is `restore`, `delete`, `noop` or `conflict`. |
| `namzu/turns/undo` | `{sessionId, turnId, planToken, resolutions?, alsoUndoLater?}` returns `{turnId, status, files, later, copies}` with each file `restored`, `removed`, `skipped`, `failed` or `noop`. `resolutions` maps a path to `skip` (the default) or `keep_copy`, which saves the file as it is now before the turn's version goes back. |

`undo` plans again on the server. If the disk or the history moved since the preview, nothing is written and the result is `{status: 'plan-changed', files: {}, replan}` with the new preview, so a client shows it instead of applying a plan the operator never saw. Unknown parameters, a malformed turn id or resolution, a conversation this project does not own and an untrusted folder are refused. `undo` is also refused while a reply is running or being constructed, while a background command is running, while another undo is writing, while the Pal is paused or busy, and no prompt starts under an undo.

None of the three builds a model session: a conversation nobody has opened in this process is read and undone from `file-history/` and the disk alone. When the conversation is open, its own store is used so the two cannot disagree.

After a successful undo that wrote or removed files, the open session's observation ledger is told those paths are behind the disk, so the model's next edit of one is refused until it reads the file again, and the next prompt carries a short system note naming the files. The note is held in the CLI process: an undo done while the host then restarts before the next prompt loses the note (the ledger refusal still holds, because the ledger is rebuilt from history against the new disk).

## In Desktop

Desktop's reply card offers Undo from `undo-status` and confirms from `undo-preview`; see [Undoing a reply](desktop.md#undoing-a-reply). It sends only `keep_copy` resolutions (a conflict not named is skipped), passes the plan token it previewed, and shows a `plan-changed` answer's `replan` in place instead of applying it. The time on an undone reply's chip is the Desktop window's own clock at the moment it saw the undo; `undo-status` carries no time, so a reopened conversation shows "Undone" alone.

## Not covered

Shell commands (`bash`, jobs, `run_code`) change files the history cannot see; a turn that ran one says so. Sub-agent edits, files over 8 MiB, files outside the project and edits made inside a sandbox are recorded as skipped, with the path and the reason. Fork support exists in the store (a fork adopts its parent's manifests up to the fork point and hard-links the bodies) and is not yet wired to the fork commands.

## Limits worth knowing

- An edit that was in flight when the process crashed is settled on the next open from the file as it then is. If you changed that same file by hand between the crash and the next open, the undo cannot tell your change from the model's.
- A kept copy of a file an undo replaced is never expired with its turn.
- A manifest this version cannot read is left alone, and so are the bodies it may name.
