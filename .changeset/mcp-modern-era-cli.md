---
"@namzu/cli": minor
---

Every MCP server the CLI connects to is now asked `server/discover` at MCP `2026-07-28` before the legacy `initialize` handshake is offered (via `@namzu/sdk`'s `MCPClient`), so a server that only speaks the 2026-07-28 revision — which has no `initialize` at all — connects for the first time.

**What an operator observes.** One extra round trip on first contact per HTTP origin or per stdio command, then nothing: the resolved era is cached for the process. Against a server that answers an unknown method with an error, that is a round trip's latency. Against one that ignores unknown methods entirely it is the SDK's `eraProbeTimeoutMs`, 2 seconds by default; measured against a real child process of that kind, `mcp add`-style connects finish in about 2s, well inside the CLI's unchanged 10s `connectTimeoutMs`. No CLI-owned flag, config key or default changes — as with the legacy-era broadening two releases ago, this is an operator-visible improvement delivered through the SDK dependency rather than a change to anything the CLI declares as its own surface, which is what makes it minor rather than major.
