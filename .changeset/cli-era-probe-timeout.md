---
"@namzu/cli": minor
---

New optional `eraProbeTimeoutMs` on an `mcpServers` entry, letting one server override how long its era probe (`server/discover`, sent before the legacy `initialize` handshake) waits before falling back — validated like `connectTimeoutMs` and refused rather than silently defaulted when given but not a positive number of milliseconds. Useful for a stdio server known to be old and slow to connect: shortening the probe leaves more of `connectTimeoutMs` for the handshake that will actually answer. Unconfigured servers are unaffected — the SDK's own default and clamp apply exactly as before.

[Tool servers](../docs/cli/mcp-servers.md#the-era-probe) also documents the era probe's operator-visible cost for the first time: one extra round trip on first contact per origin or resolved command, cached afterward, and the probe's own timeout once against a legacy server old enough to stay silent on it.
