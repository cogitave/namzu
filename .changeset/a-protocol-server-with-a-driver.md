---
'@namzu/sdk': minor
'@namzu/cli': minor
---

An agent-client protocol bridge over stdio, and `namzu acp` to drive it. An editor extension or a CI orchestrator could previously do two things: shell out to the CLI and scrape stdout, or embed this SDK in its own process. This is the third.

**The command ships in the same change as the bridge, and that is the point.** `MCPServer` and `ServerStdioTransport` are both exported from this package, and nothing in the tree has ever constructed an `MCPServer` — a complete protocol server with no driver, which reads as a supported feature and is not one. A subprocess test spawns the real binary and completes a handshake over a real pipe, so removing the registration fails a test rather than quietly repeating that shape.

New: `ACPServer`, `toAcpSessionUpdate`, `toAcpStopReason`, the `Acp*` wire types, and `ACP_METHODS` / `ACP_PROTOCOL_VERSION` / `ACP_ERROR_CODES` / `ACP_PERMISSION_CAPABILITY`. Scope is the session core — initialize and capability exchange, session creation, prompting with streamed updates, and cancellation. No new dependency: it runs on the `ServerStdioTransport` this package already had.

**The method set cannot drift from the pinned version.** `ACP_METHODS` and the server's handler map are authored independently and compared in both directions by a test: a handler nobody advertises fails, and an advertised method with no handler fails. Deriving one from the other would have made that test a tautology.

**A session is REFUSED when the client declared no permission capability**, naming the capability. Approval routing lands separately; until it does, a session that cannot ask a human anything and runs every tool regardless is not a degraded version of asking — it is the opposite of it, arrived at by omission.

**Tool calls are rendered by the tool, never by the bridge.** Updates carry a `ToolCallView` from `createToolPresenter`, and a test asserts no module here contains a tool-name comparison — a front end that switched on `'edit'` could never give a diff to a tool it had not heard of. The client-visible command list is `HostCommandRegistry.describe()` verbatim, asserted by registering a command the bridge has never heard of and expecting it to appear.

An unknown method answers `-32601` and the connection stays open; a malformed frame is survived. Both are asserted against the spawned binary, as is the one that matters most for stdio: **nothing but protocol reaches stdout**, with info-level logging on.

`namzu acp` builds its session lazily, at the first prompt. `initialize` and `session/new` are how a client discovers what this agent is and what it requires, and neither needs a model — building the session up front made a namzu with no configured credential answer a connection attempt by exiting, so an editor saw a pipe that closed with the reason on a stderr nobody was reading.
