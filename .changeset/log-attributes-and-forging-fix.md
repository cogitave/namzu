---
'@namzu/sdk': minor
---

Add `LogAttributes`, and close the two live log-forging (CWE-117) sites

`packages/sdk/src/utils/log/attributes.ts` adds `LogAttributes` — a namespaced (`namzu.*` / `gen_ai.*` / `service.*` / `exception.*`), shape-safe attribute type (`string | number | boolean`, or an array of those; no nested objects, no `null`/`undefined`). It is a type callers build TOWARD, not a narrowing of `Logger.child(context: LogContext)` — `LogContext` keeps its exact `Record<string, unknown>` shape, so no host `Logger` implementation breaks.

Two call sites used to interpolate externally-influenced text straight into a log message: `connector/mcp/client.ts` (a remote MCP server's self-reported name) and `vault/InMemoryCredentialVault.ts` (a caller-supplied credential label, and the tenant id and credential id alongside it). A hostile value embedding its own fake log line — `x\n[2026-01-01T00:00:00Z] [ERROR] [audit] forged` — forged a second record in every reader downstream. Both sites now log a constant body string with the variable text carried in a `LogAttributes` attribute instead.

`prettySink`'s control-byte escaping — previously scoped to `body` and `scope` only — now covers every rendered attribute value too, and additionally escapes DEL (0x7F) and U+2028/U+2029, neither of which `JSON.stringify` touches on its own. Closing the escaping gap only on `body`/`scope` would have left exactly the field the fix above moves untrusted text into unprotected.

`docs/sdk/observability/logging.md` (new) states the guarantee's actual boundary: `LogAttributes` is a key-shape guarantee only. Any string value can still carry a secret; the record-boundary redaction scan (`redact.ts`, shipped with the LogSink seam) is the value-level defence.
