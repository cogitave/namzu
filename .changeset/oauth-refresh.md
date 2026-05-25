---
'@namzu/cli': minor
---

**Auto-renew the Claude Code OAuth token so it no longer 401s when it expires.**

When namzu authenticates with the Claude Code OAuth credential from the macOS Keychain, that access token is short-lived (~8h). Previously namzu read it once at startup and held it for the whole session, so a token that lapsed — typically between turns of a long-lived session — surfaced as `Provider stream error: 401 … Invalid authentication credentials` with no way to recover.

namzu now refreshes it automatically: before each turn it re-reads the Keychain (picking up a token Claude Code itself may have rotated) and, if the token is at/near expiry, exchanges the refresh token for a fresh one against Anthropic's OAuth endpoint, persisting the result back to the Keychain so it survives future launches. The client is only rebuilt when the token actually changes. Credentials from environment variables or clawtool secrets (which have no refresh path) are never touched.
