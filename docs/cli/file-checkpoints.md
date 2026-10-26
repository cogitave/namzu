---
type: Reference
title: File checkpoints
description: How the interactive session records every file before a tool changes it, per turn, and how /restore puts the tree back to before a turn — what is covered, what is not, and how the rewind dialog (Esc Esc, /rewind) offers it.
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

## Rewind

Esc Esc on an empty composer (the second press within 800 ms of the first; the first shows nothing), and `/rewind` with its aliases `/undo` and `/checkpoint`, open the rewind dialog. It is refused while a reply is running or queued, and in a Pal conversation.

**The list.** The prompts you typed, oldest first (only what you sent to the model: a recap, a notice, a counted line of reads, an agent's row, a `!command` you ran yourself and a message a peer or the runtime added are not prompts), then `(current)`, the present; the dialog opens on `(current)` and choosing it closes the dialog. With file history on, a dim second line under each prompt says what putting the files back to before it would change: `main.ts +3 -1`, `4 files changed +9 -2`, or `No code changes`; `⚠ No code restore` means the history holds changes that cannot be tied to a prompt. The counts are worked out newest first from the saved copies, within one second in all, at most a megabyte per file side and 500 edits per file; past that, or for a binary file, the line shows the file names without `+ -`. Without file history the header reads `Restore and fork the conversation to the point before…` and there are no second lines.

**The options.** Enter on a prompt shows what it was sent with and how long ago, then, in order: `Restore code and conversation`, `Restore conversation`, `Restore code` (only when files would change; the first of these is focused, otherwise `Restore conversation`), `Summarize from here`, `Summarize up to here` (each takes optional context typed on the row, which tells the summary what to keep) and `Never mind`. Two dim lines follow the focused option: what happens to the conversation (`The conversation will be forked.`, `The conversation will be unchanged.`, or what is summarized) and what happens to the code (`The code will be restored +3 -1 in main.ts.`, or `The code will be unchanged.`). A warning notes that edits made by hand or by a shell command are not covered. Esc goes back to the list.

- **Restore code** puts the files back with the same drift-checked plan as `/restore N`, starting at the first turn that began at or after the prompt and covering every later turn. A file you changed since stays as it is and is reported. The conversation is untouched.
- **Restore conversation** continues from before the prompt in a new conversation holding everything ahead of it, with the prompt back in the composer; the original stays unchanged and in `/resume`. Files are untouched.
- **Restore code and conversation** does the code first, then the conversation. If the code step fails, the conversation is not changed and the failure is shown in the dialog, which stays open.
- **Summarize from here** replaces the prompt and everything after it with a summary and puts the prompt back in the composer. **Summarize up to here** replaces everything before the prompt with a summary and leaves the prompt and what follows as they are. Both use the model and are recorded in the conversation log like `/compact`; like it, they hide the footer's context meter until the next reply, count in `/context`'s summary tally, and leave `/context` sizing the conversation from its messages until then. Idle compaction measures from the next reply's size, not the one before the summary.

Which turns come at or after a prompt is known because each turn's manifest records the position of the prompt that began it (`promptOrdinal`). A turn from before that was recorded, or whose position no longer matches its prompt (after a compaction or summary shortened the history), is matched by the words of its prompt; one that cannot be placed either way is left out and its prompts show `⚠ No code restore`.
