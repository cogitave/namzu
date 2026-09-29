---
'@namzu/cli': major
---

An MCP server that finishes connecting or discovering tools after its startup deadline is now closed after that late result. The configured `connectTimeoutMs` applies to connection and discovery as one budget, rather than allowing each phase the full time separately. Servers whose combined handshake and discovery took longer than the configured deadline but whose individual phases each fit previously connected; raise that server's `connectTimeoutMs` if it needs more time. Timed-out servers remain named failures and cannot leave an unreported live connection behind.
