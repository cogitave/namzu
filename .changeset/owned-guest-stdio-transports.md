---
"@namzu/sdk": minor
"@namzu/sandbox": minor
---

Add optional `MCPClientConfig.transportFactory` for caller-owned transports,
preserving built-in transport configurations and the existing MCP protocol
lifecycle without launching a host subprocess as fallback.

Add optional `Sandbox.openStdio` with allocation-owned interactive guest pipes,
byte streaming, confirmed process-group shutdown and explicit per-request device
operation barriers. Idle services permit operator takeover; an unknown issued
application operation permanently fences the allocation until computer stop and
cannot be cleared by a late response or closing an external application's MCP
server. The local Pal worker must be rebuilt alongside the runtime to advertise
interactive support. Older workers refuse this capability before spawning;
ordinary foreground, background, file and desktop APIs remain available.

Keep quiet interactive services alive with bounded worker heartbeat frames,
discarded by the matching runtime before application output and without
changing request ownership or uncertain-effect barriers. Rebuild the worker
and load the matching runtime together for the interactive protocol.
