---
type: Reference
title: File checkpoints
description: How the interactive session records every file before a tool changes it, per turn, and how /restore puts the tree back to before a turn — what is covered, what is not, and how it pairs with Esc Esc.
resource: packages/cli/src/checkpoints/store.ts
tags: [cli, files, safety]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-02T00:00:00Z }
---

# File checkpoints

Before the `edit` or `write` tool changes a file, the session records the file as it is — or that it does not exist. One record per file per turn, the first change's; a second edit to the same file in the same turn does not overwrite what the turn started from. The records are a durable, turn-keyed history (see [Turn undo](turn-undo.md)) in the `<session-id>/file-history/` directory of the conversation the turn belongs to, under `NAMZU_HOME` (see [Session storage](session-storage.md)); after `/resume` or `/new`, the next turn's records go to that conversation, and `/restore` lists the turns of the conversation that is open. Each also records where the file ended up. Closing the interactive session does not delete them: they stay with the conversation, until it is deleted, or until they are 30 days past their last edit or push the history over 512 MiB, oldest first.

## `/restore`

`/restore` lists the turns that changed files, numbered, with the prompt that started each and the files it touched.

`/restore N` undoes turn N and every later turn, newest first, through the drift-checked plan described in [Turn undo](turn-undo.md): a file is written only while it still holds exactly what the turn left. Files the model changed are rewritten, files it created are removed. A file you or a shell command changed since is left as it is and reported as `kept`, with the reason; when a later turn's change to a file could not be undone, the older turn's change to it is kept too, so the file never lands in a state no turn produced. The report also lists paths no history covers and says when an undone turn ran shell commands. Nothing is deleted: the undone turns keep their manifests and bodies, marked undone, and leave the list. A turn with files left alone stays listed as partly undone; after sorting out those files, `/restore N` again finishes the rest and does nothing to files already back. The model is told what was put back, and which files were left alone, before its next turn, so it does not keep reasoning from a tree that no longer exists. The TUI offers no force option: to bring back a file it kept, put it to what the model left (or restore it by hand) and run `/restore N` again.

A restore is refused while a turn is running.

## What is and is not covered

- **Covered**: files under the working directory changed by the session's own `edit` and `write` tools on the host. A restore writes through a temporary file and a rename, so an interrupted restore leaves the old file or the restored one, and the file's permission bits come back with its content. A checkpoint of an edit that failed without changing the file is dropped, so it never lists a file the turn did not touch.
- **Not covered**: a shell command's writes (`bash`, a `!` line), a sub-agent's writes, files outside the working directory (a symlink is followed first, so a link that leads out of the project is outside; one that stays inside is restored through, and the link is kept), files over 8 MB, and edits made inside a sandbox (the path there is not the host file of the same name, so nothing is recorded and a restore never touches the host). `/restore` with no number lists what it can put back, then names each path that is not covered and why; a tree that also changed through a shell is restored for the tool writes only.

## With Esc Esc

Esc Esc on an empty composer forks the conversation before an earlier prompt and reopens it. It does not touch files. To go back in both — the conversation and the tree — use `/restore N` for the files, then Esc Esc for the prompt.
