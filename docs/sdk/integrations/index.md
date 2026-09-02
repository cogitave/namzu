# Integrations

Connectors, MCP, plugins, shell hooks, and event bridges.

* [A2A client discovery and delegation bounds](a2a-client.md) - Reference for finite A2A agent-card discovery, whole-delegation deadlines, cancellation ownership, remote task cleanup, polling validation, and the unavoidable pre-task-id uncertainty window.
* [The agent-client protocol bridge — what a peer may call, and what it must declare](agent-client-protocol.md) - How an editor or orchestrator drives a namzu agent over stdio, why a session is refused for a client that cannot ask a human, how tool calls are rendered by the tool rather than the bridge, and why the method table is two hand-written sets compared in both directions.
* [Connectors and MCP](connectors-and-mcp.md) - Build connector catalogs, expose connector instances as tools, consume remote MCP servers, and bridge connected integrations back out through MCP in @namzu/sdk.
* [Event Bridges](event-bridges.md) - Bridge internal Namzu runtime events to SSE and A2A wire formats, and convert messages, runs, and agent metadata into protocol-friendly shapes.
* [Guard model-authored web fetches](guarded-web-fetch.md) - Configure the SDK web-fetch provider with SSRF refusal, one cancellation and deadline boundary, bounded redirects, and streaming response limits.
* [Plugins and MCP Servers](plugins.md) - Load project or user plugins in @namzu/sdk, register namespaced tools and skills, execute hooks, and mount plugin-managed stdio MCP servers.
* [Shell hooks](shell-hooks.md) - Run a shell command before or after a tool call or around a run from a host's configuration, with the event on stdin, a bounded deadline, and exit code 2 as a refusal.
