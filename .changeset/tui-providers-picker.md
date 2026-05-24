---
'@namzu/cli': minor
---

**TUI picks an LLM provider, not a clawtool peer.**

The TUI's first-run picker now selects a primary LLM provider client (Anthropic / OpenAI / OpenRouter / Ollama / LM Studio / Bedrock) — what powers namzu's own chat. Clawtool peers (claude-code / codex / gemini-cli / opencode / aider / hermes) are a separate concern reserved for subagent dispatch and stay wired in the codebase as integration backbones, not as the picker target.

**Credential discovery (Hermes-style):**

For each provider in the declarative `PROVIDER_REGISTRY`, scan three sources in order:

1. **Env vars** with per-provider priority (e.g. `ANTHROPIC_API_KEY` → `ANTHROPIC_TOKEN` → `CLAUDE_CODE_OAUTH_TOKEN`).
2. **Clawtool's `~/.config/clawtool/secrets.toml`** `[secrets.X]` sections — any `ANTHROPIC_API_KEY`-style key inside a scope counts.
3. **Local server probes** — Ollama at `localhost:11434/api/tags`, LM Studio at `localhost:1234/v1/models`. Short timeout (500ms), non-throwing.

The first positive source wins; alternatives are kept so the picker can show them. Discovery never prompts for credentials — what's already on the machine is what's offered.

**Picker UX:**

- Bordered round overlay, one row per detected provider with a source-of-truth label (`via ANTHROPIC_API_KEY`, `via clawtool [secrets.work]`, `local · http://localhost:11434/api/tags`).
- Cursor + numeric 1–9 quick-select. Enter accepts, Esc cancels. The currently-saved provider is marked `← current` (for re-pick).
- Empty-state path renders an actionable hint listing where to put a credential.

**Persistence:** `~/.namzu/preferences.json` schema v2 — `{ version: 2, provider, model?, subagents?: { active[] } }`. v1 files (the previous shape that stored a clawtool peer instance) trigger a forced re-pick rather than silent auto-migration; the two primitives are semantically different. File mode 0600, parent dir 0700, atomic temp+rename.

**Agent runtime:** `agent.ts` goes back to `provider.chatStream()` direct over `@namzu/sdk`'s `ProviderRegistry.create()`. Provider packages (`@namzu/anthropic`, `@namzu/openai`, `@namzu/openrouter`, `@namzu/ollama`) lazy-import on first use so the TUI's cold start doesn't pay for providers the user hasn't picked.

**Slash:** `/model` now re-opens the picker (was an alias). `/provider` still shows the current selection.

**Tests:** 16 new (preferences v1/v2 + invariants, discoverer over env / secrets.toml / probes / multi-detect / no-detection / http-never-auto). Total 160/160 (was 144). Code surfaces kept clean of internal session-machinery references per project preference.

**Internals reshuffled:**

- New: `packages/cli/src/integrations/providers/{registry,secrets,discover,preferences}.ts`
- Replaced: `packages/cli/src/tui/{Picker,agent}.tsx/ts` — agents-as-primary path removed.
- Removed: `packages/cli/src/integrations/clawtool/preferences.{ts,test.ts}` (was the v1 store for peer instances; superseded).
- Kept: `packages/cli/src/integrations/clawtool/{agents,dispatch}.ts` — these stay shipped as the implementation backbone for subagent dispatch (`SendMessage` fan-out) when that feature lands.

**Deps added:** `@namzu/openai`, `@namzu/openrouter`, `@namzu/ollama` (workspace), `smol-toml` (~2 KB TOML reader for clawtool's secrets file).
