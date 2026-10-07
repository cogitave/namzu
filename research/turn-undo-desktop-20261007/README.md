# Per-reply Undo in Desktop, 2026-10-07

Proof for the reply card's Undo and its confirmation dialog, from the live preview (`/preview`, sample data).
Dark is 1440x900, light is 900x720. Re-run with `node research/turn-undo-desktop-20261007/capture.mjs`
(needs the desktop dev server); `capture.log` is the last run, 32 checks, none failing.

The preview's mock CLI (`src/dev/preview.ts`) keeps undo status the way the real CLI does, and the card only
ever shows what `undo-status` says. `?undo=partial`, `?undo=undone` and `?undo=moved` start a reply already
partly undone, already undone, or make the first apply find the files changed since the preview.

| File | Shows |
|---|---|
| `{dark,light}-NN-01-card-enabled.png` | Undo beside View changes on a reply with edits; the reply with no edits has no card |
| `*-02-dialog-mixed-rows.png` | Restore, Delete and two Conflict rows (changed since the reply, a later reply changed it), conflicts on Skip, "Also undo later replies", "Not covered" (larger than 8 MiB), the shell warning, the count on the primary button; focus starts on Cancel |
| `*-03-conflict-keep-copy.png` | "Restore anyway, keep my copy" chosen: the button goes from "Undo 2 files" to "Undo 3 files" |
| `*-04-later-replies.png` | "Also undo later replies" ticked: the plan reloads, the later reply's rows sit under "From later replies" |
| `*-05-result-partial.png` | After skipping the conflicts: per-file result, "Partly undone" |
| `*-06-card-partial.png` | The card afterwards: "Partly undone, 2 files kept" (read from status and a fresh plan) |
| `*-07-partial-reopened.png` | That button reopens the plan; the files already restored read "Already as before" |
| `*-08-card-undone.png` | A fully undone reply: muted "Undone at HH:MM" chip, dimmed totals |
| `*-09-plan-changed.png` | The files moved after the preview: the plan is shown again in place with a notice, nothing applied |

Checked by script on both sizes: Esc cancels and changes nothing, focus starts on Cancel, a reply that is partial or
undone when the conversation opens (no local state involved) draws that card, and plan-changed leaves the card enabled.

Not checked here: a real Electron window with a close and reopen cycle (the preview cannot stop the host), and the
queued-message warning in the browser (covered by a render test). Undo from the Changes review header is not built.
