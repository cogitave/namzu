---
"@namzu/sdk": major
---

A call the guard refuses with nobody to ask no longer costs the turn the other calls in its batch, and the temporary directory is no longer a refusal.

What breaks: the operating system's temporary directory (`os.tmpdir()`) is now a root of every turn, so a path there is no longer an `outsidePaths` escalation. That is a changed default; a host that relied on the question being asked sets `NAMZU_GUARD_TEMP_DIR=1` to keep it. Nothing wider is exempt: `/`, the home directory and the directories above the working directory stay guarded.

What changes with it: with no prompt to ask, `createReviewHandler` now decides each call of a batch on its own. The calls that pass run and each refused call gets its own reason, returned as a `modify_tools` decision whose new optional `policyRefusals` field (call id to text) carries the reasons; before this, one stray path refused the whole batch with "Nothing in this batch ran". The `*_UNATTENDED_REFUSAL` texts now say the call did not run and the rest of the batch is unaffected, and the outside-roots and catastrophic-removal refusals name the blocked path and the `--add-dir` directory that would allow it, or the reason the removal check found; a blocked `bash` command says why it matched. A handler written for the old shape needs no change. A host that switches over `modify_tools` and treats every `deny` as a person's No should read `policyRefusals` to tell the two apart.

Also: a shell command that only prints a file (`cat`, `nl`, `tac`, `less`, `more`, `bat`, `rev`, `sed -n` with a print range) and writes nothing on the same line counts as a read for `edit`'s freshness check, and `edit` on a file the session never read now hands back a small file's contents with the refusal and credits that read, so the repeat is one call.
