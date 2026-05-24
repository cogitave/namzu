---
'@namzu/cli': minor
---

**M2 — Provider profile management** (`ses_003-provider-profiles`)

`namzu providers` is now a real subcommand surface backed by `~/.namzu/providers.json`. Users persist named LLM provider configurations and the CLI surfaces them safely (secrets masked by default). M3 TUI consumes these profiles to pick a model without inline credentials in every command.

**New subcommands** under `namzu providers`:

- `ls [--show-secrets] [--type <t>]` — list configured profiles. Each row shows name, type, model, API key (masked `***1234` unless `--show-secrets`), default flag, and key source (`file` / `env` / `none`).
- `add <name> --type <type> [--api-key <k>] [--base-url <u>] [--model <m>] [--default]` — persist a new profile. Type-aware: `--organization` / `--project` for openai, `--host` for ollama/lmstudio, `--region` for bedrock, `--base-url` required for http.
- `remove <name>` — drop a profile (exit 64 if unknown).
- `default <name>` — flip the `default` flag onto one profile (mutual exclusion enforced).
- `path` — print the absolute store path (useful for env automation).

**Storage** (`packages/cli/src/integrations/providers/`):

- `~/.namzu/providers.json` — versioned (v1) JSON file, mode 0600, parent dir mode 0700. Writes are atomic (temp + rename).
- Discriminated-union `ProviderProfile` type covers the seven providers `@namzu/sdk` ships (openai, anthropic, openrouter, ollama, bedrock, http, lmstudio).
- `resolveApiKey(profile, env)` cascade: `NAMZU_<NAME>_API_KEY` → per-type vendor default (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`) → `profile.apiKey` on disk → `null`. Lets CI / containers inject secrets without touching disk.
- `maskSecret(s)` returns `***<last4>`; default-safe terminal output.
- Hand-rolled validator (no Zod yet) — zero-runtime-dep config I/O.

**Out of scope** for M2 (deferred to M3): live `providers test` (requires LLM call + TUI feedback), OAuth flows (need TUI handoff), interactive `add` prompt for `--api-key` (TTY input → M3).

**Tests**: 31 new unit cases (schema validation, mask, store round-trip + atomic + 0600 + env cascade + invariants). Total 115/115. Live smoke against a temp HOME validated full CRUD: `add` → `ls --show-secrets` → env override → `remove` → unknown-name 64-exit.

**Removed**: the M0 `providers` stub from `commands/stubs.ts`; replaced by the real `commands/providers.ts`.
