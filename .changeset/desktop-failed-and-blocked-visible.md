---
'@namzu/desktop': patch
'@namzu/cli': patch
'@namzu/sdk': minor
---

Desktop no longer hides a turn's bad news inside the folded "Worked" block. The header now says "1 command failed" or "1 action was not allowed" with a status mark, a failed command shows its last output lines under its row, a refused action shows its one-line reason, and a finished turn that changed files ends with one muted line built from the kernel's turn outcome record (what changed, and whether a check passed, failed, was not run, or had its exit status hidden by a pipe), in the same words the terminal uses. Nothing is shown for a turn that changed nothing. The CLI's desktop host sends the record as a new `namzu/session/outcome` notification and keeps it in the history snapshot (`outcome` on each turn); the SDK's `failure` tool fact gains an optional `note` (the refusal's reason). Additive only: a host that ignores the notification or the field is unchanged.
