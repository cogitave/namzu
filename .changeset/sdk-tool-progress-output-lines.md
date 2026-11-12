---
'@namzu/sdk': minor
---

A tool can say how many lines of output it has produced so far. `ToolContext.report(message, fraction?, details?)` takes an optional third argument `{ outputLines }` (the new `ToolProgressDetails`), and the `tool_progress` session event carries it as the optional `outputLines` field; the newest report wins, and a host that ignores it sees the same events as before. The built-in `bash` tool counts the line feeds of both streams and reports the count with its latest line, so a viewer can say "214 lines" without counting the (coalesced) messages it happened to receive. Nothing to change for existing tools or hosts.
