---
"@namzu/sandbox": minor
---

The microVM guest agent can now listen on a TCP port and require a per-instance
token. Both are opt-in through the environment and both are absent from every
shipped backend's configuration today, so an existing Firecracker deployment
behaves exactly as it did: with neither variable set, the agent authenticates
nothing and listens exactly where it listened before.

`NAMZU_AGENT_TCP_PORT` is a third listen mode, after `NAMZU_AGENT_UNIX_PATH`
and the inherited vsock descriptor and in that order, binding `0.0.0.0` for a
deployment that reaches the guest over a routed network rather than a
host-local socket. It fails closed: set with neither token variable it is
refused at startup, naming both, instead of binding an unauthenticated
listener. Framing, ops, execution leases, terminals, loopback TCP and
file IO are unchanged — only the listen address differs. A guest configured
with none of the three still refuses to start, and the message now names all
three.

`NAMZU_AGENT_BIND_TOKEN` makes every op except `healthz` present that exact
token in the request envelope, from the first frame of a connection; anything
else is answered `unauthorized` and the connection is closed before a handler
runs. Comparison is constant-time over a fixed-width digest, so neither the
value nor its length is learnable by probing. `NAMZU_AGENT_REQUIRE_TOKEN`
without a preset token is a fallback that binds to the first token seen and
refuses every other for the life of the process. `healthz` never requires a
token and never echoes one, so readiness probing needs no secret. An empty
`NAMZU_AGENT_BIND_TOKEN` is refused at startup in every mode — that is what a
downward-API injection looks like when it resolved to nothing.

A refused connection is destroyed rather than `end()`ed, so a refused peer can
no longer keep streaming into the agent's frame buffer over the readable half
that `end()` leaves open. Alongside it, bounds on what an unauthenticated peer
may spend before the gate — which cannot run until a whole frame is parsed,
because the credential rides inside the envelope.
`NAMZU_AGENT_MAX_FRAME_BYTES` (default 256 MiB) caps the length ANY frame
header may announce, on every listen mode, where the 8-hex prefix used to allow
4 GiB. `NAMZU_AGENT_REFUSAL_FLUSH_GRACE_MS` (default 1s) likewise applies
everywhere: it is how long a refusal frame may take to reach the wire before
the socket is destroyed regardless, so a peer that stops reading cannot hold a
refusal open. `NAMZU_AGENT_MAX_PREAUTH_FRAME_BYTES` (default 8 MiB),
`NAMZU_AGENT_MAX_PREAUTH_CONNECTIONS` (default 64),
`NAMZU_AGENT_MAX_PREAUTH_BUFFER_BYTES` (default 32 MiB),
`NAMZU_AGENT_PREAUTH_IDLE_TIMEOUT_MS` (default 10s) and
`NAMZU_AGENT_PREAUTH_DEADLINE_MS` (default 10s) apply only in the token
modes, so the Firecracker path sees none of them; together they bound what an
unauthenticated peer can make the agent hold to one number rather than to a
number per connection. One bound needs no variable and applies everywhere: a
frame header is exactly nine bytes, so a peer streaming bytes with no newline
in them is refused on the ninth rather than buffered against a newline that
never arrives. Note what the pre-auth cap
costs in a token mode: a `write-file` body shares the first frame with the
token, so that cap is the ceiling on the body — about 6 MiB of file content at
the default — and a body above it is refused `frame_too_large`, naming the
limit and the variable to raise.

Two of those pre-auth bounds are shaped by a slow loris rather than by a flood,
and an operator who tunes them should know which is which.
`NAMZU_AGENT_PREAUTH_IDLE_TIMEOUT_MS` is an idle timer that every byte resets,
so on its own it retires only a silent connection;
`NAMZU_AGENT_PREAUTH_DEADLINE_MS` runs from accept, is reset by nothing, and is
the bound a peer dripping one byte every few seconds actually meets. And a full
pre-auth pool evicts its **oldest** unauthenticated connection — answering it
`too_many_unauthenticated_connections` — rather than refusing the arrival, so a
poolful of squatters can no longer decide that nobody else, `healthz` included,
gets served. None of this stops a peer that can reach the port from causing
churn; the NetworkPolicy ingress rule in front of that port is the boundary,
and these bounds are defence in depth behind it.

The guest protocol version is deliberately NOT bumped: `token` is an optional,
additive envelope field, and the wire is otherwise byte-for-byte what it was.
Taking this release therefore requires no coupled rollout — no golden image has
to be rebuilt and no host has to be redeployed in step with it. A deployment
that wants the new modes turns them on in its own pod or image environment.

Read `NAMZU_AGENT_BIND_TOKEN` as an instance credential, not an isolation
boundary: the agent and the workload share a uid after deprivileging, so a
workload can read the agent's own environment out of `/proc`. It is
per-instance for that reason, and the network rule in front of the agent port
is the boundary it sits behind.

One behaviour changes for every existing deployment, Firecracker included, and
it is the reason to read this entry before upgrading. The `terminal` op used to
hand its shell the agent's whole environment; it now gets the same scrubbed
environment an `execute` child has always had, with every `NAMZU_AGENT_*` and
`NAMZU_SANDBOX_*` variable removed, and so does the `stty` resize helper behind
it. That closed a hole this release would otherwise have opened — the bind
token was visible in an interactive shell — and it means a terminal session no
longer sees the agent's own settings, such as `NAMZU_SANDBOX_WORKSPACE`. A
workload that needs a value in its terminal passes it in `env` on the
`openTerminal` call, which still wins over everything else, `TERM` included.
The bump stays `minor`: nothing exported changes shape, and the environment a
terminal is handed is guest-internal behaviour rather than a typed API, but it
is a change a terminal user can observe.
