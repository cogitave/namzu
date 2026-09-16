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

## Not yet built

- **The 2026-07-28 ("modern") era.** `McpEra`'s `modern` arm exists so a
  later workstream has somewhere to put the result of a real modern-era
  negotiation — the stateless per-request `_meta`, the `server/discover`
  probe, and the two-probe (HTTP body-inspection vs. stdio timeout) state
  machine that decides whether a given origin speaks it at all. Nothing in
  this workstream constructs a `modern` era value.
- **The `-32022` retry-with-narrower-version path**, `x-mcp-header`
  validation, `resultType`/MRTR handling, the additional content block
  types, and legacy session/stream fidelity (404 re-initialize, `DELETE` on
  close, `Last-Event-ID` resumption) are each their own later section of
  this page.
