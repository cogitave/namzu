---
'@namzu/sdk': minor
'@namzu/sandbox': minor
---

A command running in a sandbox now reports progress while it runs

Both halves of this existed and neither was connected to the other.

Every container worker streams its output a chunk at a time — the wire has always carried `stdout_delta` and `stderr_delta` events — and every backend concatenated those chunks into a string and returned it when the process exited. Separately, `ToolContext.report` exists precisely to answer "is it still working?", is supplied per call by the executor, emits a `tool_progress` event, and is mapped onto the event stream for live consumers. It had **no caller anywhere in the tree**.

So a command that ran for eight minutes said nothing for eight minutes, over a transport that had been reporting the whole time.

**New:** `SandboxExecOptions.onOutput`, called as output arrives. Optional and additive — a backend that cannot stream never calls it, and `SandboxExecResult.stdout` still carries the complete output either way, so a caller that ignores it behaves exactly as before. Wired through the two container backends that carry the streaming worker protocol.

**The `bash` builtin now uses it**, sending the last non-empty line of each chunk to `context.report`. A progress slot renders one line and replaces it, so sending a whole chunk would put a wall of text in a space that shows one line of it.

Progress is ephemeral by design — `tool_progress` is excluded from the durable transcript so a tool reporting every file it compiles cannot write thousands of lines into the record. The model is still given `result.stdout`; this is a status signal, not a second copy of the output.
