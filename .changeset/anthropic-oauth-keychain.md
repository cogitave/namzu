---
'@namzu/cli': patch
'@namzu/anthropic': minor
---

**Auto-pick Claude Code's macOS Keychain OAuth token; OAuth-aware Anthropic provider; tighter picker UX.**

Hotfix landing two coupled pieces — namzu now starts cleanly on a host where claude-code is already signed in, without asking the user to export anything.

**Credentials side (`@namzu/cli`):**

- New: macOS Keychain reader. Reads the `Claude Code-credentials` generic-password entry from the login Keychain and extracts the `claudeAiOauth.accessToken` JSON field. Pattern ported from Nous Research's hermes-agent (`agent/anthropic_adapter.py:_read_claude_code_credentials_from_keychain`). Non-throwing — every failure path (non-Darwin, security command missing, entry absent, payload malformed) returns null so the discoverer treats it as "no source" rather than crashing.
- Discoverer extended: after env vars and clawtool `secrets.toml`, anthropic also accepts the Keychain credential. Detection source is reported as `keychain · Claude Code-credentials` in the picker, so the user can see where their token came from.
- Token-shape detector: `isAnthropicOAuthToken(value)` identifies OAuth tokens by prefix (`cc-`, `sk-ant-oat`, `eyJ`) vs console API keys (`sk-ant-api`). Drives the apiKey-vs-authToken decision when constructing the Anthropic provider.

**Provider side (`@namzu/anthropic`):**

- `AnthropicConfig.apiKey` is now optional, mutually exclusive with the new `authToken` field. Exactly one must be set; the constructor throws if neither is.
- When `authToken` is supplied, the underlying `@anthropic-ai/sdk` client is constructed with `authToken: <token>` (Bearer auth) and the `anthropic-beta: oauth-2025-04-20` header is injected so Anthropic's OAuth routes accept the request. User-supplied `defaultHeaders` merge on top.
- API-key path unchanged — existing `apiKey` callers see no behavior change.

**Picker UX:**

- Width capped at 72 chars; previously stretched to the full terminal and looked uncomfortable on wide screens.
- Empty-state copy tightened — concrete `export ANTHROPIC_API_KEY=…` lines instead of a long paragraph; explicit mention that on macOS a signed-in claude-code is auto-detected via the Keychain.
- Source labels condensed (`env · ANTHROPIC_API_KEY`, `keychain · Claude Code-credentials`, `clawtool · [work]`, `local · localhost:11434/api/tags`).

**Tests:** 5 new keychain unit cases (token-shape detection) plus existing discover tests updated to opt out of host-ambient sources (`skipKeychain: true`) so the suite stays hermetic on any laptop. Total 165/165 (was 160).

**Live verification:** on this machine, `namzu` now auto-detects the Claude Code OAuth credential from the Keychain, picker shows `Anthropic (Claude)  keychain · Claude Code-credentials  ← current` after first pick, and `provider.chatStream()` constructs through the Bearer-auth path with the required beta header.
