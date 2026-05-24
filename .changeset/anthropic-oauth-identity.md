---
'@namzu/anthropic': patch
---

**Complete the Claude Code OAuth identity so tokens actually authorize.**

A valid (non-expired) Claude Code OAuth token was still rejected with `401 Invalid authentication credentials` because Anthropic authorizes OAuth-scoped tokens only when the request carries the full Claude Code identity, not just Bearer auth. When `authToken` is set, the provider now sends:

- `anthropic-beta: claude-code-20250219,oauth-2025-04-20` (both flags, was only the second).
- `user-agent: claude-cli/<version> (external, cli)` — version detected from the installed `claude` binary, with a static fallback (Anthropic validates the version server-side).
- A leading system block `"You are Claude Code, Anthropic's official CLI for Claude."` — required as the first `system` element on OAuth requests.

All three apply only on the `authToken` path; the `apiKey` (console key, `x-api-key`) path is unchanged. Verified end-to-end against the live Anthropic API.
