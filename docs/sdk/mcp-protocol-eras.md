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
- no `Last-Event-ID` — resumable SSE streams are not supported
- **no `notifications/cancelled` POST on Streamable HTTP** — closing the SSE
  response stream *is* the cancellation signal there, so the notification
  would be a second, redundant POST. stdio has no stream to close, so it
  still sends it, in every era. This is the only thing the modern era
  changes about cancellation; the ordering guarantees in `request()` are
  untouched.

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

There is no per-call or per-server opt out of probing. A caller that needs
the previous behaviour — the legacy handshake and nothing else — pins the
previous major of `@namzu/sdk`.

## Not yet built

- **`subscriptions/listen`.** The modern era replaces the `GET` stream and
  `resources/subscribe` with it. This client has no subscription support in
  any era, so omitting it regresses nothing — but it does mean a modern
  connection receives no server-initiated notifications at all. Tracked
  separately.
- **`x-mcp-header` validation and `Mcp-Param-*` construction.** The base64
  sentinel encoder that work needs (`encodeMcpHeaderValue`) ships here; the
  tool-definition validation, the header extraction and the `-32020`
  re-list-and-retry do not.
- **`resultType` / MRTR handling** — `complete` versus `input_required`, and
  what a client with no declared capabilities does with an
  `InputRequiredResult`.
- **Legacy session and stream fidelity** — 404 re-initialize, `DELETE` on
  close, `Last-Event-ID` resumption. All legacy-only by construction; the
  modern era already does none of them, as listed above.
