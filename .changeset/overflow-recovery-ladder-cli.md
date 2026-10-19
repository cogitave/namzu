---
'@namzu/cli': patch
---

When a conversation is too long for the model and Namzu could not shorten it, the message now says so and suggests trying again or choosing a model with more room with /model; it no longer tells you to start a new conversation with /new. The automatic-compaction stop after three failures no longer prints a line, and the "context filled up again" stop names the large file or tool output and suggests reading it in smaller parts instead of `/clear`. With `--debug` or in `exec` output, an overflow that compaction could not help adds a `Compaction:` row with the cause.
