---
type: Reference
title: MCP protocol eras
description: The era model behind MCP negotiation — the modern-first two-probe state machine, the per-origin era cache, the single-round-trip legacy handshake, and why there is no waterfall.
resource: packages/sdk/src/connector/mcp/client.ts
tags: [sdk, mcp, connector, protocol]
status: stable
---

# MCP protocol eras

MCP has published several protocol revisions, and a real deployment mixes
them: a server built against 2024-11-05 sits next to one that has moved to
2025-11-25. `MCPClient` resolves which revision a given connection actually
speaks and records the answer as an `McpEra` — everything downstream
(whether to attach `_meta`, whether to send `MCP-Protocol-Version`, whether
sessions exist at all) reads that instead of re-deriving it from a version
string.

`connect()` resolves the era by probing for the current spec revision
(2026-07-28, the "modern" era) and falling back to the `initialize`
handshake when the peer does not answer in the modern vocabulary. Which arm
a connection lands on is the server's answer, not a configuration.

## The era model

```ts
import type { McpEra } from '@namzu/sdk'

declare const era: McpEra
if (era.kind === 'modern') {
	// era.version: '2026-07-28'
} else {
	// era.version: '2025-11-25' | '2025-06-18' | '2025-03-26' | '2024-11-05'
}
```

`MCPClient.getEra()` returns the `McpEra` the last `connect()` negotiated, or
`undefined` before a connection exists.

## Resolving the era: two probes, never a waterfall

`connect()` sends one `server/discover` request before it offers anything
else. `server/discover` is mandatory for a 2026-07-28 server and optional
for a client, which is exactly what makes it a usable probe: a server that
answers it speaks the modern protocol, and one that does not says so in a
way this client can read.

Modern first is a deliberate default and it costs a round trip against the
legacy servers that are still the overwhelming majority. The alternative is
worse than wasted latency: a legacy server handed an era-ambiguous method
processes it under legacy semantics and fails confusingly, where a probe
fails cleanly and recovers. The [era cache](#the-era-cache) makes the cost
one round trip per origin rather than one per connection.

### The two probes are not the same algorithm

| | Streamable HTTP | stdio |
|---|---|---|
| modern answer | `2xx` carrying a `DiscoverResult` | a reply carrying a `DiscoverResult` |
| modern objection | `400`/`404`/`405` whose **body** is `-32022`, `-32021`, `-32020`, or `-32601` on a `404` | a reply carrying one of those JSON-RPC errors |
| fall back | `400`/`404`/`405` with an empty, HTML or otherwise non-JSON-RPC body | any other error reply — **or silence** |

The HTTP probe reads a status and then a body. The status alone decides
nothing: a modern server answers an unknown method with `404` plus a
JSON-RPC `-32601` specifically so a client can tell it apart from the `404`
of an origin that has never heard of the protocol. `-32601` therefore counts
as a modern answer **only on a `404`** — on a `400` or `405` it is an
ordinary unimplemented-method reply that a server of any era can send.

The stdio probe has no status to read, and the spec is explicit that its
fallback **MUST NOT** be keyed to one specific error code: a legacy server
refuses an unknown method with whatever its implementation happens to use,
commonly `-32601`, commonly `-32602`, sometimes nothing at all. The
predicate in the code is therefore `isRecognizedModernError` — "did the peer
answer in a vocabulary only a modern server has?" — and never a comparison
against a number. Silence resolves legacy after
`MCPClientConfig.eraProbeTimeoutMs` (default `2000`).

That timeout is a heuristic with no good universal value, which is why it is
configurable: too short and a slow-starting server is misclassified, too
long and every legacy server pays the wait. It is also clamped to
`requestTimeoutMs`, because a probe is a request and one that outlived the
bound every other request is held to would be a connect that hangs past its
own timeout.

The `http-sse` transport is never probed. It is the 2024-11-05 transport, so
an origin reached through it is legacy by the operator's own choice of
transport and the probe would spend a round trip learning what the config
already said.

### A success that is not a `DiscoverResult` is not proof

A `2xx` (or a stdio reply) whose body is not a well-formed `DiscoverResult` —
no `supportedVersions` array, or an empty one — resolves **legacy**. This is
stricter than "a `2xx` means modern", on purpose: a legacy server that
answers unknown methods with `{}` rather than an error would otherwise be
read as modern, and this client would spend the rest of the connection
sending `_meta` to a peer that has never heard of it.

### `-32022`: intersect, take the newest, retry at most once

A `-32022` (`UnsupportedProtocolVersion`) carries `data.supported`. This
client intersects that list with `MCP_SUPPORTED_PROTOCOL_VERSIONS`, takes
the newest member of the intersection, and:

- **newest is modern, and is not the version just attempted** — probe once
  more at that version. Exactly one retry; there is no loop.
- **newest is modern and IS the version just attempted** — the server is
  contradicting itself, but it answered in the modern vocabulary, so the era
  settles modern at that version rather than spending a round trip asking a
  question already answered.
- **newest is legacy** — the server named the era it wants. Stop probing and
  offer the legacy handshake.
- **the intersection is empty** — refuse, with an error naming the server's
  list and this client's. A version outside this client's set is never
  attempted: offering one it has not implemented produces a malformed
  exchange later instead of a clean negotiation failure now.

## The era cache

A resolved era is remembered per HTTP **origin** (scheme, host and port —
never per URL path, because the era is a property of the server behind the
origin) or per stdio **process identity** (the working directory, the
command and its arguments — `cwd` is in the key because a relative command
resolves against it, so the same command line in two directories is two
servers). `streamable_http` and `streamable-http` are two spellings of one
transport and key together; `http-sse` keys apart on the same origin,
because it is never probed and so records a legacy era it never tested.
`MCPClientConfig.eraCache` injects an `MCPEraCache`; omitting it uses a
process-wide default shared by every `MCPClient`, so two clients reaching
the same origin do not each pay a probe.

It is an injectable interface rather than a module-level `Map` for a reason
that is about tests and not about hosts: a process-global cache leaks a
resolved era from one case into the next, and a conformance suite whose
cases pass only because of the order they ran in proves nothing.

What the cache actually saves is the **wasted** probe:

- **Cached legacy** — no probe at all. `connect()` goes straight to
  `initialize`. This is the case that matters today, and it is why
  modern-first is affordable.
- **Cached modern** — `server/discover` is still sent, because on a modern
  connection it *is* the connection: there is no handshake, and the discover
  result carries the server's capabilities. The cache is not skipping a
  round trip there, it is skipping the fallback.

It is corrected, not trusted blindly:

- A remembered **modern** origin that starts answering as legacy is replaced
  with `legacy` in that same connect. The stale assumption costs exactly one
  probe, once; the next connection goes straight to the handshake.
- A remembered era whose handshake then **fails** is dropped entirely, so
  the next `connect()` re-resolves from scratch rather than inheriting the
  assumption that just failed. The two directions are not symmetric, and it
  is worth saying plainly which way costs more: a remembered **modern**
  origin that has gone legacy is corrected inside the connect that
  discovered it, but a remembered **legacy** peer that has become
  modern-only is not re-probed inside that connect — `initialize` is sent,
  the server refuses it, and `connect()` fails in front of the operator.
  The entry is dropped on the way out, so the next attempt re-probes and
  succeeds. A server upgrading across an era boundary therefore costs one
  visible connect failure per client process, once.
- A reconnect renegotiates: the cache is a memory of the peer, not of a
  connection, so `MCPReconnectSupervisor` still runs a fresh `initialize`
  against a remembered legacy origin.

## A modern connection: what it sends, and what it does not

A modern connection is **stateless**. There is no handshake, so every
request carries its own identity in `_meta`, mirrored into headers so an
intermediary can route and authorise a call without parsing JSON-RPC:

| on the wire | value |
|---|---|
| `_meta['io.modelcontextprotocol/protocolVersion']` | the negotiated revision — REQUIRED |
| `_meta['io.modelcontextprotocol/clientCapabilities']` | `MCPClientConfig.capabilities`, or `{}` — REQUIRED |
| `_meta['io.modelcontextprotocol/clientInfo']` | `MCPClientConfig.clientInfo` — a SHOULD, omitted when absent |
| `MCP-Protocol-Version` | the same revision, from the same variable |
| `Mcp-Method` | the JSON-RPC method |
| `Mcp-Name` | `params.name` for `tools/call` and `prompts/get`, `params.uri` for `resources/read` |

`buildEnvelope` (`connector/mcp/envelope.ts`) produces the body and the
headers together, from one local variable, so the header and the `_meta` key
cannot disagree. That is the point of it being one function: the alternative
— building them in two places and asserting somewhere that they match —
makes a mismatched pair constructible and then tries to catch it.

Those three names are the protocol's, not the caller's. A per-request
`headers` entry that collides with one of them — matched without regard to
case, because HTTP field names are case-insensitive — is **refused and
warn-logged** rather than put on the wire, in both eras. Allowing it would
rebuild the mismatched pair one layer above `buildEnvelope`, and a
conforming server answers a header that disagrees with the body it mirrors
with a `400` and `-32020` that names nothing the host could act on.

A header value that cannot be written into an HTTP field verbatim is wrapped
in the base64 sentinel `=?base64?{base64}?=`. The markers are lowercase and
case-sensitive. A value that is header-safe but already *reads* as a
sentinel is wrapped too, so it survives as itself rather than being decoded
into something the caller never wrote. "Reads as a sentinel" is the spec's
own test and nothing narrower — starts with `=?base64?`, ends with `?=`,
with no claim about what lies between — so `=?base64?a?b?=` is wrapped as
well. A tighter test would pass that value through and leave the server
trying to base64-decode `a?b`.

`clientCapabilities` is `{}` and that is honest rather than a gap: sampling,
elicitation, roots and logging are all deprecated as of 2026-07-28 with "new
implementations should not add support for them", and the MRTR rules mean a
conforming server will not ask for what this client has not declared.

**A modern connection deliberately does none of the following**, all of
which the legacy eras do:

- no `initialize` and no `notifications/initialized` — the handshake is gone
- no `Mcp-Session-Id` sent or captured, even if an origin offers one
- no `GET` and no `DELETE` — there is no session to open or terminate
- no `Last-Event-ID` — resumable SSE streams are not supported (legacy does
  support it — see [Legacy session and stream fidelity](#legacy-session-and-stream-fidelity))
- **no `notifications/cancelled` POST on Streamable HTTP** — closing the SSE
  response stream *is* the cancellation signal there, so the notification
  would be a second, redundant POST. stdio has no stream to close, so it
  still sends it, in every era. This is the only thing the modern era
  changes about cancellation; the ordering guarantees in `request()` are
  untouched.

## Mirroring tool parameters into headers: `x-mcp-header`

A server may annotate a tool parameter with `x-mcp-header` to ask that the
parameter's value be copied into an HTTP request header named
`Mcp-Param-{name}`. The point is the same as `Mcp-Method` and `Mcp-Name`: a
load balancer, a proxy or a policy engine can route and authorise a tool call
without parsing JSON-RPC. Servers **MAY** use it; clients on Streamable HTTP
**MUST** support it.

```json
{
	"name": "execute_sql",
	"inputSchema": {
		"type": "object",
		"properties": {
			"region": { "type": "string", "x-mcp-header": "Region" },
			"query": { "type": "string" }
		}
	}
}
```

A call to that tool with `{ "region": "us-west1", … }` carries
`Mcp-Param-Region: us-west1` alongside the body that already holds the same
value. `buildEnvelope` reads it out of the very `params` object it returns,
for the reason the protocol version is written from one variable: a server
rejects a header that disagrees with the body it mirrors, so the two must not
be readable from two places that could drift apart.

### namzu refuses a tool whose annotation is invalid

This is the first place namzu declines to expose something a server offered,
and it is worth stating plainly: **a server can publish a tool that namzu will
not show the model.** The refusal is per tool, never per listing — one
malformed definition among fifty leaves forty-nine usable — and every refusal
is logged at `warn` with the tool name and the reason
(`namzu.mcp.tool`, `namzu.mcp.reason`). An operator whose roster is missing a
tool should look there first.

The six constraints, each of which refuses the whole tool definition:

| the `x-mcp-header` value | refused when |
|---|---|
| non-empty | it is `""`, or not a string at all |
| HTTP field-name token syntax | it is not RFC 9110 `1*tchar` — a space, a colon, a quote |
| no control characters | it carries CR or LF (the injection case: a field name that ends mid-value) |
| case-insensitively unique across the whole `inputSchema` | `Region` and `region` both appear |
| a primitive parameter type — `string`, `boolean` or `integer` | it annotates a `number`, an array, an object, or a parameter with no declared `type` |
| statically reachable from the schema root through `properties` keys alone | the chain passes through `items`, `oneOf`/`anyOf`/`allOf`/`not`, `if`/`then`/`else` or `$ref` — or the annotation sits on the schema root |

The last one is the subtle one, and it decides how the validator is written.
The tempting implementation resolves `$ref`s and flattens `allOf` first and
then walks the result — at which point a `$ref`-reached property looks exactly
like an ordinary `properties` child and the tool is admitted. namzu walks the
**raw** schema and never follows a reference, so a reachable path is one that
really was a chain of `properties` keys. It also scans the whole schema for
annotations rather than only the reachable part, because an annotation under
`items` is not something to ignore — it is what makes the definition invalid.

Two things that are *not* annotations and must not be read as ones: an
instance value under `default`, `example`/`examples`, `const` or `enum` (a
tool may legitimately default an object-typed parameter to
`{"x-mcp-header": …}`), and a parameter legitimately **named**
`x-mcp-header`. The walk knows which JSON Schema keywords hold a map of
schemas, so neither is mistaken for one.

A host holding a schema of its own can ask the same question:

```ts
import { validateMcpHeaderAnnotations } from '@namzu/sdk'

const verdict = validateMcpHeaderAnnotations({
	type: 'object',
	properties: { region: { type: 'string', 'x-mcp-header': 'Region' } },
})
if (verdict.ok) {
	// verdict.bindings: [{ header: 'Mcp-Param-Region', path: ['region'], type: 'string' }]
}
```

Validation runs inside `MCPClient.listTools()` rather than in
`MCPToolDiscovery` or the tool adapter, because the CLI's own
`connectMcpServers()` calls `listTools()` directly and never touches
discovery. Putting it one layer up would exempt the caller that matters most.

### Which connections mirror, and which merely validate

| | validates and excludes | writes `Mcp-Param-*` |
|---|---|---|
| Streamable HTTP, modern era | yes | yes |
| Streamable HTTP, legacy era | yes | no |
| stdio, any era | no | no |
| HTTP+SSE | no | no |

Validation follows the **transport**, because that is how the spec conditions
it — "clients using the Streamable HTTP transport MUST reject…", and "clients
using other transports (e.g., stdio) MAY ignore `x-mcp-header` annotations
entirely". Following the transport rather than the era also means a roster
does not change shape the day the origin behind it stops answering
`initialize`. The headers themselves follow the **era**: they are a 2026-07-28
wire feature, and a legacy request carries none of the modern mirroring.

### What goes in the field, and when nothing does

A value is converted to its string form — a `string` as-is, a `boolean` as
lowercase `true`/`false`, an `integer` as a decimal string — and then through
the same base64 sentinel rule as `Mcp-Name`
(see [A modern connection](#a-modern-connection-what-it-sends-and-what-it-does-not)).

| argument value | header |
|---|---|
| `"us-west1"` | `Mcp-Param-Region: us-west1` |
| `"Hello, 世界"` | `Mcp-Param-Greeting: =?base64?SGVsbG8sIOS4lueVjA==?=` |
| `" padded "` | `Mcp-Param-Text: =?base64?IHBhZGRlZCA=?=` |
| `"line1\nline2"` | `Mcp-Param-Text: =?base64?bGluZTEKbGluZTI=?=` |
| `"=?base64?literal?="` | `Mcp-Param-Val: =?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=` |

The header is **omitted**, never sent empty, when the argument is absent or
`null` — the spec's own rule, and the server correspondingly does not expect
it. namzu omits it in two further cases, both of which are a server
contradicting its own schema: an argument whose runtime type is not the
declared one, and an integer outside ±(2^53−1), the range the spec bounds
these to and the range in which the number this client parsed is still the
number the server sent. Sending either would put a value on the wire that
disagrees with the body beside it, which is the one thing a conforming server
refuses outright.

Bindings come from a listing this client actually read. A `callTool()` made
before any `listTools()` carries no mirrored header rather than a guessed one,
and a reconnect starts with none.

### `-32020`: re-list once, retry once

A conforming server answers a request whose `Mcp-Param-*` headers are missing
or disagree with the body with `400 Bad Request` and JSON-RPC `-32020`
(`HeaderMismatch`). That is a legitimate thing for a server to do to a
well-behaved client: the tool's `inputSchema` may have changed between the
listing and the call. The spec's recovery, and namzu's, is to call
`tools/list` again, rebuild the headers from the schema the server publishes
now, and retry the original request — **once**. The retry does not go back
through `callTool()`, so a second `-32020` surfaces to the caller rather than
starting a third round trip. The failure that surfaces is the HTTP one, and it
carries the response body (`MCPHttpStatusError.bodyText`), which is where the
error code is.

Both shapes are recognised: the `400`-with-a-body the spec describes, and a
`200` carrying a JSON-RPC `-32020` frame. Recognising only the second would
leave the recovery dead on exactly the path the spec specifies.

## One `initialize` round trip, not a waterfall

Once the probe has resolved legacy, `connect()` offers the newest legacy
version it speaks — `2025-11-25` — in a single
`initialize` request, and accepts whatever the server answers with, provided
that answer is one of the versions this client supports. A server is free to
negotiate down (or, in principle, to a version it prefers for other reasons):
that is how the handshake is specified, and `namzu` used to ignore the
answer entirely, which made a server that negotiated to an unspeakable
version look like a healthy connection until something downstream broke in
a confusing way.

This is deliberately **one** round trip. The spec's own backward-compatibility
algorithm for the legacy handshake offers a single version and honors
whatever the server answers with — it does not describe a client retrying
`initialize` once per version it supports
(<https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle>).
A three-step waterfall (offer 2025-11-25, then 2025-06-18, then 2025-03-26 as
separate attempts) would be three times the latency for a code path no real
server expects, and would still need to fall back further for a server that
only speaks 2024-11-05. `protocol-negotiation.test.ts` counts `initialize`
frames sent per connection attempt specifically so this stays a regression
that fails loudly if reintroduced.

A server that omits `protocolVersion` from its `initialize` result is
tolerated exactly as before: it is treated as having accepted the offered
version.

## The supported set

| version | offered by `connect()` | accepted as an `initialize` answer | `MCP-Protocol-Version` header on later requests |
|---|---|---|---|
| 2026-07-28 | yes (the probe) | **no** — see below | yes, on every request |
| 2025-11-25 | yes (the handshake offer) | yes | yes |
| 2025-06-18 | no | yes | yes |
| 2025-03-26 | no | yes | no — header did not exist yet |
| 2024-11-05 | no | yes | no — header did not exist yet |

A server that answers `initialize` with `2026-07-28` is refused too, and for
a different reason: a real modern server does not implement `initialize` at
all, so that success shape is a server contradicting itself. Accepting it
would record a `legacy` era at a version that is not a legacy one, and then
write that version number onto requests carrying none of what it requires.

A server that negotiates to a version outside this set is refused, with an
error naming the version offered, the version the server answered with, and
every version this client supports. There is no attempt to speak a version
outside the set anyway "just in case" — the existing reasoning behind the
single-version constant this replaced (advertise and accept only what you
have actually verified this client can carry a legacy handshake for) argues
for exactly this broadened set, not against it.

### The `MCP-Protocol-Version` header

The header was introduced in the 2025-06-18 revision, so sending it to a
server that negotiated an older version is off-spec — that server has no
defined way to interpret it. On a legacy connection `MCPClient` sends it on
every request that follows `initialize` (2025-06-18 and 2025-11-25 only),
and never on `initialize` itself, since the negotiated version is not known
until that request's reply arrives. On a modern connection it is sent on
every request including the probe, and means the version carried in *that
request's* `_meta` rather than one negotiated for a session.

## Legacy session and stream fidelity

Three behaviors the 2025-03-26 through 2025-11-25 Streamable HTTP transports
specify, and that a legacy connection now does. All three are gated to
legacy **structurally**, not by a flag threaded through the transport: a
modern connection never sends `initialize` (it probes with `server/discover`
instead), so `StreamableHttpTransport` never captures a `Mcp-Session-Id` in
the first place, and each behavior below is conditioned on a session id
being present.

**A session `404` triggers exactly one re-initialize.** A legacy server that
has forgotten a session — expired it, restarted, whatever the reason —
answers a request carrying its stale `Mcp-Session-Id` with a bare `404`. On
that specific failure, `MCPClient` drops the session id and runs the
`initialize`/`notifications/initialized` handshake again from scratch,
then retries the original request exactly once. A second `404` — from the
retried request, on the freshly re-initialized session — surfaces as a
failure rather than triggering a second recovery; masking a genuinely broken
server as a transient hiccup forever would be worse than a clean error. The
re-initialize only ever runs for a request issued after `connect()` has
already completed — the *first* `initialize` of a connection has no session
yet to lose, so a `404` there is an ordinary connection failure, not a
recovery trigger.

**`close()` sends a best-effort `DELETE`.** A legacy connection that
established a session tells the server it is done with it: `close()` fires a
`DELETE` carrying `Mcp-Session-Id`, and never awaits it — the request is
fire-and-forget, bounded by its own short timeout, so a peer that never
answers (or is simply gone) cannot delay or fail the transport's existing
bounded-teardown guarantee. A modern connection never sends this either: it
never held a session id to name.

**`Last-Event-ID` arms a legacy reconnect.** `parseSseMessages`
(`connector/mcp/streamable-http.ts`) now captures the newest SSE `id:` field
it sees, across every event in a response body — including one whose `data:`
was empty, the priming event the 2025-11-25 transport mandates. The captured
id survives a `close()`/`connect()` cycle (deliberately: that is the whole
point of it) and is sent as `Last-Event-ID` on the next request built on a
session, so a server that supports resumption can replay whatever this
client may have missed across the gap. A `:`-prefixed comment or keep-alive
line, and any other field this parser does not read, are ignored rather than
treated as malformed — already true before this workstream for everything
but `id:`, since both filters select a line by its own prefix and so already
ignore anything else.

This client's Streamable HTTP transport buffers each response fully rather
than holding a live SSE stream open across requests (see `dispatchResponseMessages`),
so "resumption" here is narrower than the spec's GET-stream reconnection: it
is a best-effort hint carried on the next ordinary request after a
reconnect, not a dedicated resumed stream. Real fidelity to the full
GET-stream resumption story is future work; this closes the gap the SSE
parser itself had (event ids were parsed and thrown away).

## Changed defaults

Twice, in two releases.

**The advertised legacy version.** `connect()` once offered and accepted
only `2024-11-05`. It now offers `2025-11-25` and accepts a negotiated
answer anywhere in the table above. A server that branches its behavior on
the client's claimed version sees `2025-11-25` on the wire instead, and sees
a different subset of the wire (the `MCP-Protocol-Version` header appearing
on requests) depending what it negotiates down to.

**The negotiation order.** `connect()` no longer opens with `initialize`. It
opens with a `server/discover` probe and offers the handshake only when that
probe says the peer is legacy. The first request a server sees from this
client is therefore a method that did not exist before 2026-07-28.

Neither has a per-call override: a caller that needs the previous behavior
pins the previous major version of `@namzu/sdk`.

## `namzu`'s own MCP server still answers 2024-11-05

`packages/sdk/src/connector/mcp/server/server.ts` is namzu's MCP **server**
implementation — the direction that reverses everything else on this page,
where this process answers somebody else's client rather than calling
somebody else's server. It still hardcodes `2024-11-05` in its `initialize`
reply and implements no `server/discover`. This means a `namzu`-built client
connecting to a `namzu`-built server probes, is refused, and negotiates down
to `2024-11-05` even though the client now offers `2026-07-28` first and
`2025-11-25` second. That is expected, not a bug: modernising the server
half is out of scope (issue #471 is client-only).

## Per-request authority: injectable fetch, bearer token, headers

Both HTTP transports — `StreamableHttpTransport` and `HttpSseTransport` —
took the ambient global `fetch` as a given, and the only credential
mechanism was a static header map fixed for the transport's whole life. That
was already awkward for testing (every test either stubbed `globalThis.fetch`
or hit a real socket) and is a hard blocker for the modern era, whose entire
job is per-request `_meta` and header construction. This workstream adds the
seam without changing what a zero-config connection sends.

### The injectable `fetch`

`MCPStreamableHttpTransportConfig` and `MCPHttpSseTransportConfig` both gain
an optional `fetch?: MCPFetchLike`:

```ts
import type { MCPFetchLike } from '@namzu/sdk'

declare const fetch: MCPFetchLike
// (input: string, init?: { method?; headers?; body?; redirect?; signal? }) => Promise<Response>
```

Each transport captures `config.fetch ?? fetch` once, at construction, and
every HTTP call it makes — for `HttpSseTransport` that is both the SSE `GET`
stream and the message `POST`, not only the one a test happens to exercise —
goes through that captured value. When `config.fetch` is supplied, the
ambient global is never even read, let alone called: `??` short-circuits on
the left operand.

`MCPFetchLike` is structurally the same *idea* as `FetchLike` in
`bridge/a2a/client.ts` — an injectable, socket-free function shape so a test
needs no real network — but is a separate, re-declared type rather than an
import of that one. Both MCP transports already read `.headers` (content
type, session id) and `HttpSseTransport`'s GET reads `.body` as a stream,
neither of which the A2A bridge's narrower `{ok, status, json(), text()}`
return type exposes; the return type here is the real `Response`, so nothing
downstream of the fetch call changed shape. The A2A bridge is left alone
rather than forced to grow fields only MCP needs.

### Per-request headers and bearer token

`MCPRequestOptions` — the options bag `MCPClient.listTools()`, `callTool()`,
`readResource()`, `getPrompt()` and the rest already accepted for `signal` —
gains two more optional fields:

```ts sketch
await client.callTool(
	'create_issue',
	{ title: 'Bug' },
	{
		headers: { 'X-Tenant': 'acme' },
		bearerToken: 'eyJ...',
	},
)
```

`headers` merges over the transport's static config headers for this one
request; a key collision resolves to the per-request value, with one
exception — `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` belong to
the protocol, and a per-request value under any of those names is refused
and warn-logged (see [A modern connection](#a-modern-connection-what-it-sends-and-what-it-does-not)).
`bearerToken`,
if given, is applied last as `Authorization: Bearer <token>` — after the
merge — so it overrides a configured `Authorization` header (static, or
supplied through this same call's `headers`) without touching a
differently-named header such as a static `X-API-Key`. Neither field is
threaded through `notify()` or the internal `notifications/cancelled` send:
those are not requests the caller shaped, so there is nothing per-call to
carry.

Supplying neither field — the entire existing call surface — produces a
request whose headers are exactly what they were before this workstream.

### The redirect boundary still applies

`refuseMcpHttpRedirect` runs unchanged: a 3xx response still fails the
request rather than being followed, regardless of whether the credential
that reached the (non-redirecting) origin was a static config header or a
per-request `bearerToken`/`headers` value. `http-redirect-boundary.test.ts`
proves this for both credential shapes at the same assertion, rather than in
two parallel tests, specifically so the two paths are proven equivalent
instead of independently plausible.

### A pre-existing gap this workstream also closed

`MCPTransportSendOptions.headers` — added for the `MCP-Protocol-Version`
header — was already threaded into `StreamableHttpTransport`'s header
merge, but `HttpSseTransport`'s message `POST` built its headers inline and
never read it, so a per-send header silently never reached the wire on that
transport. `HttpSseTransport` now has a `buildHeaders()` merge matching
`StreamableHttpTransport`'s, so both HTTP transports treat per-request
headers and a bearer token identically.

## MRTR: `resultType` and a typed `input_required` outcome

Any JSON-RPC result can carry a `resultType`: absent or `"complete"` is an
ordinary answer, and `"input_required"` is a server saying it cannot finish
without something the client has to gather first — an elicitation, a
sampled message, a list of roots. `envelope.ts`'s `decodeResult` reads this
past the wire shape:

```ts sketch
type MCPDecodedResult =
	| { kind: 'complete'; result: unknown }
	| { kind: 'input_required'; inputRequests?: MCPInputRequest[]; requestState?: string }

declare function decodeResult(raw: unknown): MCPDecodedResult
```

Absent `resultType` decodes as `complete` — every legacy result, and every
modern result before this, carries none, and the spec's own words are that
a client "MUST treat an absent resultType as complete". The other MUST is
just as literal: "a resultType of any value unrecognized by the client MUST
be considered invalid" — `decodeResult` throws `MCPInvalidResultTypeError`
rather than passing an unknown shape through as if it meant something.

### Why namzu almost never sees `input_required` with anything in it

`MCPClient` declares `clientCapabilities: {}` in every era (see
[Not yet built](#not-yet-built) — no sampling, elicitation, roots or
logging). MRTR's own rule 7 says a server **MUST NOT** send an
`inputRequests` entry for a capability the client did not declare, so a
**conforming** server can only ever answer this client with a
`requestState`-only `InputRequiredResult`: nothing for namzu to gather,
just a token to echo back. `MCPClient.callTool` retries that case
automatically, exactly once, under a fresh JSON-RPC id, with `requestState`
carried back byte-for-byte as a top-level `requestState` parameter
alongside the original `name`/`arguments` — the same shape `listAllPages`
already uses for a pagination `cursor`. The spec's own words license this:
the client MAY retry immediately when there is nothing to gather. Nothing
about `requestState` is ever inspected, parsed or logged in full; it is
opaque to this client by design.

Everything else is the defensive path for a **non-conforming** server:

- An `InputRequiredResult` that does carry `inputRequests` this client
  cannot satisfy.
- A second `input_required` answer after the one automatic retry.

Both throw `MCPInputRequiredError` out of `MCPClient.callTool` rather than
looping or returning something that looks like success. The genuinely
likely failure for a no-capability host is not this at all, though — it is
the separate `-32021 MissingRequiredClientCapability` error a server sends
when it refuses a call outright because this client never declared what
the call needs.

### The typed, catchable outcome

`mcpToolToToolDefinition`'s `execute` catches both cases and returns a
`ToolResult` rather than letting either reach the model host as an
unexplained rejection — the same pattern the redirect boundary already uses
for `mcp_tool_outcome_unknown`:

```ts sketch
// MCPInputRequiredError
{
	success: false,
	output: '',
	error: 'MCP tool "…" on server "…" asked for input this client has no way to supply (elicitation/create).',
	data: {
		code: 'mcp_tool_input_required',
		server: string,
		tool: string,
		requested: string[], // the inputRequests' method names
		retrySafety: 'safe',
	},
}

// -32021 MissingRequiredClientCapability
{
	success: false,
	output: '',
	error: 'MCP tool "…" on server "…" requires client capabilities this client did not declare (sampling).',
	data: {
		code: 'mcp_tool_missing_client_capability',
		server: string,
		tool: string,
		requiredCapabilities: string[], // from the error's data.requiredCapabilities
		retrySafety: 'safe',
	},
}
```

`retrySafety` is `'safe'` on both: the spec's model is that a call ending in
`input_required` has not truly run yet, and a `-32021` refusal happens
before the server does anything the call asked for. Both outcomes still
pass through `frameServerResult`, so the `error` text carries the same
untrusted-content envelope every other connector tool result does before it
reaches a model.

This is additive: no existing `MCPToolResult` or `ToolResult` shape
changes, and a legacy result with no `resultType` — every result a
pre-MRTR server ever sent — decodes exactly as it always has.

## What an operator sees change

First contact with a given origin (or stdio command) costs one extra round
trip: the `server/discover` probe, before the `initialize` it falls back to.
Every later connection to the same origin skips it. Against a server that
answers an unknown method with an error — the common case — the probe costs
a round trip's latency; against one that ignores unknown methods entirely it
costs `eraProbeTimeoutMs` (2s by default), which the CLI's 10s
`connectTimeoutMs` default accommodates with room to spare. That budget is
measured, not assumed: `packages/cli/src/integrations/mcp/__tests__/connect.test.ts`
connects to a real child process that ignores the probe and asserts the
whole connect fits inside the default.

A host that was setting `MCP-Protocol-Version`, `Mcp-Method` or `Mcp-Name`
through `MCPRequestOptions.headers` sees that value dropped and a warning
logged, naming the header. Every other per-request header is unaffected.

A tool the roster used to carry can now be absent: a server whose tool
definition breaks one of the
[`x-mcp-header` constraints](#namzu-refuses-a-tool-whose-annotation-is-invalid)
has that tool excluded from `listTools()`, with the tool name and the reason
logged at `warn`. Only tools carrying that annotation can be affected, and
only on the Streamable HTTP transport.

There is no per-call or per-server opt out of probing. A caller that needs
the previous behaviour — the legacy handshake and nothing else — pins the
previous major of `@namzu/sdk`.

A tool call that a server answers with `input_required` or `-32021` no
longer surfaces as a bare rejection: it comes back as a `ToolResult` with
`success: false` and a `data.code` of `mcp_tool_input_required` or
`mcp_tool_missing_client_capability` (see
[MRTR](#mrtr-resulttype-and-a-typed-input_required-outcome)) — a host
reading `ToolResult.data` today sees a new code it previously never could.

## Not yet built

- **`subscriptions/listen`.** The modern era replaces the `GET` stream and
  `resources/subscribe` with it. This client has no subscription support in
  any era, so omitting it regresses nothing — but it does mean a modern
  connection receives no server-initiated notifications at all. Tracked
  separately.
