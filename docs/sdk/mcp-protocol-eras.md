---
type: Reference
title: MCP protocol eras
description: The era model behind MCP negotiation, the single-round-trip legacy handshake across four versions, and why there is no waterfall.
resource: packages/sdk/src/connector/mcp/client.ts
tags: [sdk, mcp, connector, protocol]
status: stable
---

# MCP protocol eras

MCP has published several protocol revisions, and a real deployment mixes
them: a server built against 2024-11-05 sits next to one that has moved to
2025-11-25. `MCPClient` resolves which revision a given connection actually
speaks and records the answer as an `McpEra` — everything downstream (whether
to send `MCP-Protocol-Version`, later: whether to attach `_meta`, whether
sessions exist at all) reads that instead of re-deriving it from a version
string.

This page grows as later work reaches further eras. As of this workstream, a
connection always resolves `kind: 'legacy'` — reaching the current spec
revision, 2026-07-28, is separate work described under [Not yet
built](#not-yet-built) below.

## The era model

```ts
import type { McpEra } from '@namzu/sdk'

declare const era: McpEra
if (era.kind === 'legacy') {
	// era.version: '2025-11-25' | '2025-06-18' | '2025-03-26' | '2024-11-05'
}
```

`MCPClient.getEra()` returns the `McpEra` the last `connect()` negotiated, or
`undefined` before a connection exists.

## One `initialize` round trip, not a waterfall

`connect()` offers the newest version it speaks — `2025-11-25` — in a single
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

| version | offered by `connect()` | accepted if a server answers with it | `MCP-Protocol-Version` header on later requests |
|---|---|---|---|
| 2025-11-25 | yes (the offer) | yes | yes |
| 2025-06-18 | no | yes | yes |
| 2025-03-26 | no | yes | no — header did not exist yet |
| 2024-11-05 | no | yes | no — header did not exist yet |

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
defined way to interpret it. `MCPClient` sends it on every request that
follows `initialize` (2025-06-18 and 2025-11-25 only), and never on
`initialize` itself, since the negotiated version is not known until that
request's reply arrives.

## Changed default

Before this workstream, `connect()` offered and accepted only `2024-11-05`.
It now offers `2025-11-25` and accepts a negotiated answer anywhere in the
table above. A host that was relying on the client only ever advertising
`2024-11-05` — for instance a server that branches its behavior on the
client's claimed version — now sees `2025-11-25` on the wire instead, and
sees a different subset of the wire (the `MCP-Protocol-Version` header
appearing on requests) depending what the server negotiates down to.

There is no per-call override: a caller that needs the previous behavior
(offer and accept only `2024-11-05`) pins the previous major version of
`@namzu/sdk`.

## `namzu`'s own MCP server still answers 2024-11-05

`packages/sdk/src/connector/mcp/server/server.ts` is namzu's MCP **server**
implementation — the direction that reverses everything else on this page,
where this process answers somebody else's client rather than calling
somebody else's server. It still hardcodes `2024-11-05` in its `initialize`
reply. This means a `namzu`-built client connecting to a `namzu`-built
server negotiates down to `2024-11-05` even though the client now offers
`2025-11-25`. That is expected, not a bug: broadening the server's own
negotiation is out of scope for this workstream (issue #471 is client-only).

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
request; a key collision resolves to the per-request value. `bearerToken`,
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

## Not yet built

- **The 2026-07-28 ("modern") era.** `McpEra`'s `modern` arm exists so a
  later workstream has somewhere to put the result of a real modern-era
  negotiation — the stateless per-request `_meta`, the `server/discover`
  probe, and the two-probe (HTTP body-inspection vs. stdio timeout) state
  machine that decides whether a given origin speaks it at all. Nothing in
  this workstream constructs a `modern` era value. The per-request `headers`
  authority above is the seam that work will build `_meta` and its mirrored
  headers on top of.
- **The `-32022` retry-with-narrower-version path**, `x-mcp-header`
  validation, `resultType`/MRTR handling, the additional content block
  types, and legacy session/stream fidelity (404 re-initialize, `DELETE` on
  close, `Last-Event-ID` resumption) are each their own later section of
  this page.
