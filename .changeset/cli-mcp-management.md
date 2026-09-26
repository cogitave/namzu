---
"@namzu/cli": minor
---

Add `namzu mcp list|get|add|remove` for user-owned tool servers. Existing server config continues to work, including names outside the new-entry naming rule. These commands write `~/.namzu/config.yaml`, preserve other settings, accept environment-backed Bearer headers, require HTTPS for URL queries or credential headers outside loopback, and hide credential-bearing values in their output.
