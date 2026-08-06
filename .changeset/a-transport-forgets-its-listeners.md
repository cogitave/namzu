---
'@namzu/sdk': patch
---

An MCP transport forgets its listeners when the session closes.

`onMessage`, `onClose` and `onError` appended to arrays that nothing ever
drained. `MCPClient.connect()` calls all three once each, and it is reachable
again after `disconnect()` — the guard only refuses when the status is already
`connected`. So every reconnect stacked another set on the last: after n
cycles one inbound message dispatched to n handlers, n-1 of them closures over
sessions that had ended. `rejectAllPending` and `emitLifecycle` fired n times
per close, and each stale closure held its old client state alive for as long
as the transport object did.

All three transports clear their handlers now — **after** notifying, never
before.

The ordering is the whole fix. `HttpSseTransport` and `StreamableHttpTransport`
call their close handlers inside `close()`, so they clear immediately
afterwards. `StdioTransport` does not: its close handlers run from the child
process's own `close` event, which arrives after `close()` has returned.
Clearing there — the obvious one-line change — would mean nothing tells
`MCPClient` the session ended, so its status would stay `connected` and the
next `connect()` would be refused with "already connected". Its handlers are
dropped after that event fires instead, with the never-spawned case handled
separately so a retry after a failed spawn does not stack a second set.

Not changed, and worth knowing: the two HTTP transports disagree about closing
a transport that was never connected — streamable returns early and notifies
nobody, http-sse notifies regardless. Making them agree changes what a host
observes and deserves its own decision.
