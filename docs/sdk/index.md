# SDK

The kernel: architecture, runtime contracts, tools, observability, and integrations.

* [The kernel in depth — thesis, subsystems and the event protocol](architecture.md) - Architecture reference for @namzu/sdk: what the kernel is and deliberately is not, every subsystem from the sandbox boundary to multi-tenant isolation, the design principles the code is held to, and the agent event protocol a host consumes.
* [Command execution lifetime and cancellation](command-execution-lifetime.md) - Reference for bounded local command output, cancellation outcomes, nullable exits, remote cancellation refusal, and disconnect or teardown ownership in SDK execution contexts.
* [Durable message-feedback revisions](feedback-store-revisions.md) - Reference for exact message-feedback compare-and-set updates, immutable disk commits, legacy projection handling, filesystem requirements, safe identifiers, and shared-root upgrades.
* [Session-owned completion goals](session-goals.md) - Reference for durable completion goals in @namzu/sdk, including Session authority, exact revisions, lifecycle transitions, disk publication, and the boundary between goal state and automatic continuation.
* [Durable topic revisions and shared-store upgrades](topic-store-revisions.md) - Reference for exact topic-state and objective revisions, immutable disk commits, crash behavior, tenant isolation, filesystem requirements, and safe upgrades of a shared store.

# Sections

* [directory](directory/) - An agent as a directory on disk.
* [integrations](integrations/) - Connectors, MCP, plugins, shell hooks, and event bridges.
* [observability](observability/) - Logging and session export.
* [runtime](runtime/) - Runtime contracts and bounds a host relies on.
* [tools](tools/) - Defining tools, the built-ins, safety, and delegates.
