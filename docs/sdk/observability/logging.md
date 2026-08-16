---
uid: namzu.sdk.observability.logging
title: The log pipeline — sink seam, record shape, and the audit boundary
description: Where a host plugs its own destination in, what a record carries and what the LogAttributes allowlist does and does not guarantee, how a record is defended against log forging, and why the audit trail is a separate pipeline rather than a log level.
type: Guide
diataxis: explanation
owner: cogitave/namzu
status: active
timestamp: 2026-08-16T00:00:00Z
lastReviewed: 2026-08-16
resource: packages/sdk/src/utils/logger.ts
tags: [logging, observability, sdk]
---

# The log pipeline

A host owns its log destination. The kernel builds records, redacts them,
caps their size, and hands them to whatever sink the host installed — and
when nobody installs one, it says so rather than pretending the records
were fine.

## The sink seam

`installProcessSink(sink, level)` claims the process's destination. One
call, one owner: a second call throws unless it passes `{ replace: true }`,
because two callers each believing they own the destination is a defect,
not something to merge silently — the second would win with neither party
told.

```ts
import { installProcessSink, prettySink } from '@namzu/sdk'

installProcessSink(prettySink(process.stderr), 'info')
```

Three properties are worth knowing before you write your own sink:

- **The level is read per record**, off a mutable holder, never resolved
  once at construction. A logger built before your sink was installed
  still routes through it.
- **Your `emit` is arbitrary code the kernel does not control**, so a
  throw from it is caught. One bad record cannot fail a run — which means
  a sink that throws on every record is invisible except in the counters.
- **The counters are per destination.** `getLogCounters()` returns what
  the pipeline did to this process's records: how many never reached the
  sink, how many had a value redacted, how many were shed or truncated by
  the caps. It returns `undefined` when no sink is installed — not five
  zeros, which would read as "nothing was dropped" about a process where
  nothing was measured. `namzu doctor` reports that row.

## Correlation

When telemetry is active, a record carries `traceId`, `spanId` and
`traceFlags` from the span it happened inside, read per record. With no
tracer registered the fields are absent rather than empty — the
unconfigured case costs nothing and produces no fields.

## Writing an adapter

Namzu attribute keys are flat and dotted. That is what makes them
collision-free across modules and greppable in an NDJSON stream, and it is
also what a collector with a nested schema will not accept. The mapping
has a real cost: `namzu.run.id` and `namzu.run.id.value` are both valid
flat keys and cannot both exist as nested objects. An adapter either
refuses the conflicting key set or silently loses one of the two fields,
and which one it loses depends on iteration order.

This adapter refuses. It is not typed into this page — it is
`packages/sdk/src/__fixtures__/nested-attribute-sink.ts`, embedded
verbatim, and
`packages/sdk/src/utils/__tests__/a-documented-sink-adapter-compiles.test.ts`
drives it through the real pipeline and asserts these bytes match that
file. A sample a page hand-copies compiles on the day it is written and
silently stops compiling afterwards while still reading as authoritative.

```ts verbatim
// from: packages/sdk/src/__fixtures__/nested-attribute-sink.ts
export interface CollectorPayload {
	readonly timestamp: string
	readonly severity: string
	readonly message: string
	readonly fields: Record<string, unknown>
}

export function nestedAttributeSink(send: (payload: CollectorPayload) => void): LogSink {
	return {
		emit(record: LogRecord): void {
			send({
				timestamp: new Date(record.timestamp).toISOString(),
				severity: record.severityText,
				message: record.body,
				fields: nest(record.attributes),
			})
		},
	}
}

/** `{'a.b': 1}` becomes `{a: {b: 1}}`. Throws where the two shapes disagree. */
export function nest(flat: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(flat)) {
		const parts = key.split('.')
		let node = out
		for (const [i, part] of parts.slice(0, -1).entries()) {
			const existing = node[part]
			if (existing !== undefined && !isPlainObject(existing)) {
				// `refuse-do-not-degrade`: silently overwriting one of the two
				// keys loses a field the caller logged, and which one it loses
				// depends on `Object.entries` order.
				throw new Error(
					`cannot nest ${key}: ${parts.slice(0, i + 1).join('.')} is already a value, not an object`,
				)
			}
			if (existing === undefined) node[part] = {}
			node = node[part] as Record<string, unknown>
		}
		node[parts[parts.length - 1] as string] = value
	}
	return out
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
```

## What `LogAttributes` is

```ts sketch
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

```ts sketch
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

```ts sketch
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
