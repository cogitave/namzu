---
title: Log Attributes and Log-Forging Protection
description: The LogAttributes allowlist type — what its compile-time guarantee covers and does not — and how jsonLinesSink and prettySink defend against log forging (CWE-117). Also covers the audit trail's separation from the operational log.
last_updated: 2026-08-16
status: current
related_packages: ["@namzu/sdk"]
---

# Log Attributes and Log-Forging Protection

`packages/sdk/src/utils/log/attributes.ts` exports `LogAttributes` — a
compile-time allowlist for the attribute half of a structured log call.
This page states what that type buys, and — just as importantly — what it
does not.

## What `LogAttributes` is

```ts
export type LogAttributes = Readonly<Record<AttributeKey, AttributeValue>>
```

- **Keys** are restricted to the four namespaced prefixes the rest of the
  telemetry surface already uses: `namzu.*`, `gen_ai.*`, `service.*`,
  `exception.*`. An un-namespaced key — `serverId`, `label`, `apiKey` — is a
  compile error.
- **Values** are restricted to `string | number | boolean`, or a readonly
  array of those — the OTel `AnyValue` subset with objects removed. You
  cannot compile `{ 'namzu.connector.auth': someAuthConfigObject }`; the
  shape is not expressible.
- An explicit `null` or `undefined` value is also a compile error — an
  attribute key that is present holds a value, or it is not present.

## What it does NOT buy — read this before trusting it

**`LogAttributes` is a key-shape guarantee only.** It says nothing about
what a *string* value contains. This compiles cleanly and carries a secret
straight through:

```ts
const attrs: LogAttributes = {
  // a namespaced key, a string value — legal, and still a secret.
  'namzu.connector.auth': JSON.stringify(auth),
}
```

The type cannot see that the string came from `JSON.stringify(auth)`
rather than, say, a server name. Closing that gap is **not** the type's
job — it is the record-boundary redaction scan
(`packages/sdk/src/utils/log/redact.ts`), which runs inside `createLogger`
on every record, before any sink sees it, and replaces anything matching
`LOG_SECRET_PATTERNS` with `[REDACTED:<label>]`. That scan is defence in
depth and is documented as a denylist, not a guarantee — a value-shaped
secret the pattern table does not recognise still reaches the sink.
Nothing about `LogAttributes` changes that.

**Any string value can still carry a secret. `LogAttributes` narrows the
surface a caller can express; the redaction scan is what actually looks at
the content.** A claim that this type makes leakage inexpressible is
wrong, and should not appear on this page or anywhere else it is
documented.

## Using it at a call site

`Logger.child(context: LogContext)` on `packages/sdk/src/utils/logger.ts`
is unchanged — `LogContext` stays `Record<string, unknown>` because it is
in *input* position on the public surface (`logger?: Logger` on
`RunConfig` and tool config) and narrowing it would break every host that
already implemented `Logger` correctly. Build the variable half of a call
as `LogAttributes` and pass the result where `LogContext` is expected —
every `LogAttributes` value is a valid `LogContext` value:

```ts
const attributes: LogAttributes = {
  'namzu.connector.server.name': result.serverInfo.name,
}
this.log.info('Connected to MCP server', attributes)
```

Note the **constant body**. `result.serverInfo.name` is text a remote MCP
server chose, not text the kernel authored — see the next section for why
that distinction is load-bearing.

## Log forging (CWE-117) and why the body must be constant

`packages/sdk/src/connector/mcp/client.ts` and
`packages/sdk/src/vault/InMemoryCredentialVault.ts` used to interpolate
externally-influenced text directly into a log message: a remote MCP
server's self-reported name, and a caller-supplied credential label
(alongside the tenant id). A server or caller could name itself
`x\n[2026-01-01T00:00:00Z] [ERROR] [audit] forged` and forge a second,
fake log line in the operator's terminal or NDJSON stream. Both sites now
log a **constant body string** with the variable text carried in a
`LogAttributes` attribute instead — the pattern shown above.

Both built-in sinks additionally defend the record as a whole, so a
constant body is not the only thing standing between an attacker and a
forged line:

- **`jsonLinesSink`** — one JSON object per line. `JSON.stringify`
  neutralises `\n`/`\r` in every field by construction, and the sink
  additionally escapes U+2028/U+2029 (LINE SEPARATOR / PARAGRAPH
  SEPARATOR) — codepoints `JSON.stringify` leaves literal, and which some
  NDJSON readers treat as line terminators regardless of the JSON quoting
  around them.
- **`prettySink`** — the human-readable renderer `namzu run` writes to a
  terminal by default. Every rendered field — `body`, `scope`, and every
  attribute value — is passed through the same control-byte and
  ESC-sequence escape before it reaches the stream, so a forged ANSI
  escape sequence survives as inert text (`\x1b[31m`) rather than live
  bytes a terminal would act on. The escape also covers DEL (0x7F) and
  U+2028/U+2029 in attribute values — bytes `JSON.stringify` does not
  touch on its own. Earlier drafts of this escaping covered only the
  message body; scoping it to one field would have left every attribute
  value — where the fix above moves the untrusted text *to* — unprotected.
  It now covers every rendered value, for the same reason
  `LOG_SECRET_PATTERNS` scans the whole record rather than one sink: a
  defence that only covers one path of several is not a defence, it is a
  false sense of one.

## Audit trail vs operational log

Two separate pipelines, not one with an `audit` level. Everything that makes
an operational log good — level-filtered, sink-injected, sampleable, and
legitimately *absent* when no host installed a sink — makes it a bad audit
record. The kernel's own claim (its README: "an auditable trail of what it
did and what it cost") cannot be contingent on a host remembering to
configure logging.

| | Audit record | Operational log |
|---|---|---|
| Answers | what the agent did, under whose identity, at what cost, whether it was allowed | why is this slow, what did the process decide |
| Durability | required — a write failure fails the operation | best-effort — a sink failure never fails the operation |
| Filtering | never level-filtered, never sampled | both |
| Home | `RunStore.appendAuditEvent` / `readAuditEvents` | `LogSink` |
| Ordering | its own monotonic `seq`, independent of `RunEvent.seq` | timestamp only |

`packages/sdk/src/types/run/audit.ts` defines `AuditEvent`: who (agent id,
tenant, persona when the run was configured with one), what (action, tool,
resource), when (timestamp, `seq`, trace context when telemetry is active),
outcome (`'success' | 'failure' | 'refused'` — `'refused'` is a first-class
value, never an absent record), and cost (`CostInfo`, **non-optional**).

**The append-only audit trail is authoritative.** `Run.costInfo` /
`Run.status`, persisted through `RunStore.writeRunMeta`, are a **derived
summary cache** — a full-record overwrite with no `seq` and no prior-value
retention. `replayRun` (`types/run/audit.ts`) reconstructs a completed run's
cost and status from the trail alone; a divergence from the persisted `Run`
record is a defect in the summary, never in the trail.

**The bridge, one direction only.** `RunPersistence.recordAudit` writes the
audit entry first — a `RunStore` that does not implement `appendAuditEvent`
refuses rather than silently running without one — and, only once that write
lands, emits at most one operational log record (`namzu.audit.written`,
`info`) carrying `namzu.audit.event_id` and `namzu.audit.seq`: a pointer,
never a copy of the event's own content. There is no `logger.audit()` — the
reverse direction does not exist, because if both pipelines carried the same
content the operational one's rotation and sampling would produce a second,
diverging history of the same events.

**Compatibility note:** because `recordAudit` is now called from every run's
completion and failure path, a host supplying its own `RunStore` must
implement `appendAuditEvent`/`readAuditEvents` — see this release's
changeset for the migration.

## Related

- [Telemetry](./README.md)
- `packages/sdk/src/utils/log/attributes.ts` — the type
- `packages/sdk/src/utils/log/redact.ts` — the value-level scan
- `packages/sdk/src/utils/log/sinks.ts` — `jsonLinesSink` and `prettySink`
- `packages/sdk/src/types/run/audit.ts` — `AuditEvent`, `replayRun`
- `packages/sdk/src/manager/run/persistence.ts` — `RunPersistence.recordAudit`
