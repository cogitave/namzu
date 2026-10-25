---
'@namzu/cli': patch
---

Diff rows and result bodies are laid out consistently. A changed row of an edit no longer ends in a stray `…` once the row has moved into scrollback; the line numbers of a hunk start from the line the hunk begins at before the change; the room the live view reserves for a change counts every wrapped row; a declined edit in a forked conversation is numbered like the live one; a created file's lines and every other result body hang from the same column as a shell call's output (a result body no longer carries a `▏` rule); and a message you sent that was longer than 10,000 characters is echoed by its first and last 2,500 characters with a `(N lines, ~M KB hidden)` divider (the model still receives all of it). The persisted hint counter in `hint-counts.json` is now named `queuedMessagesHint`; a counter saved by an earlier prerelease under the old name is ignored and counts again from zero.
