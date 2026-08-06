---
'@namzu/cli': minor
---

namzu can connect to the tool servers you declare

The kernel has spoken this protocol for a long time — `MCPClient`,
`StdioTransport`, `StreamableHttpTransport` and the tool adapter are all
exported from `@namzu/sdk`. `packages/cli` imported none of them. So the
capability existed and was unreachable from the product: a namzu user could not
connect an external tool server at all, whatever the kernel could do.

Declare them under `mcpServers` in `namzu.config.json`:

```json
{
  "mcpServers": {
    "tickets": { "command": "node", "args": ["./tools/tickets-server.js"] },
    "search":  { "url": "https://tools.example.internal/mcp" }
  }
}
```

Their tools join the roster the agent works with, prefixed with the server's
name — `mcp_tickets_create` — so two servers offering the same tool do not
collide and the transcript says where a call went. A `[permissions]` rule can
name a bridged tool like any other, and the server's own read-only and
destructive hints are carried through to the gate.

**A server that does not come up is named, with the reason.** That is the whole
hazard this carries: an operator declares a server, watches the agent work
without its tools, and concludes the model is bad at the task. An entry naming
both a command and a url — or neither — is refused by name rather than guessed
at. One server failing never takes the working ones with it.

What happens next differs by who is watching, deliberately. The TUI prints the
failure and carries on: you are there, you can read it and fix your config, and
taking the session away would not help you do that. `namzu run` and
`namzu run-stream` **refuse** — nobody is watching a headless run, and a script
that quietly does half the job is worse than one that stops. `run` exits `1`;
`run-stream` emits the reason as an `error` event.

Each server gets ten seconds to start, hand shake and list its tools. A request
timeout cannot cover a process that starts and never speaks, and without a
bound one wedged server keeps namzu from starting at all — no error, no
failure.

A local server is a child process, and namzu now shuts its servers down when a
session ends: when a one-shot finishes, and when switching providers in the TUI
replaces one session with another. Nothing else in the CLI owned a child
process, which is why a session had no shutdown path before this.

Nothing to configure if you declare no servers; the roster is what it was.
