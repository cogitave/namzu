---
"@namzu/sdk": minor
"@namzu/cli": minor
---

A tool output that was cut now says one thing about how to get the rest, wherever the model meets it. The saved-file line is followed by a sentence that names only the tools the turn has: `read` (open the file, `offset`/`limit`) and, when both are mounted, `search_conversation` then `read_conversation`. The cleared-result placeholder keeps that sentence instead of its own advice, and every compaction summary of a conversation with those tools ends with a pointer to them. The built-in `read` tool now opens a regular `.txt` file in the session's own retained-output directory without a prompt (no symbolic link, no second hard link, read-only), so the pointer is true; `ToolContext.retainedOutputDirectory` is new and optional, and `CompactNowInput.recoveryNote` and `COMPACTION_RECOVERY_NOTE` are new exports. The conversation guidance no longer tells the model not to use `read`. Nothing is removed; a host that mounts neither tool still gets the neutral wording.
