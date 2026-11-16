---
'@namzu/sdk': minor
---

A file a successful `bash` call printed now counts as read for `edit` in more cases: after a leading `cd <dir> &&`, beside `ls`, `wc`, `stat` or `file` on the same line, and through `head`, `tail`, `sed -n` ranges or a pipe into another printer. A whole print (`cat`, `nl`, `sed -n p`) records the whole body; the others record a window, which `edit` accepts but which is not taken as the whole file. A failed command, a glob, a variable, a redirection into a file, a pipe into a non-printer, or a file changed after it was printed earns nothing, so `edit` still refuses it as unread or stale.
