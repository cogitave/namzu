---
"@namzu/sdk": patch
"@namzu/cli": patch
---

Bound live tool progress under host backpressure. `ToolContext.report()` now
keeps at most one in-flight and one latest pending update per call, caps each
published message at 8 KiB of UTF-8, and settles accepted progress before the
terminal event without changing the durable tool result. The interactive CLI
shows that latest progress and optional percentage on the matching live tool
row with terminal-safe rendering.
