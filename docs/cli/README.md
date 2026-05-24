---
title: CLI
description: namzu is a terminal AI agent — a TUI that discovers your LLM credentials, runs tools with your approval, and remembers context across sessions.
last_updated: 2026-05-25
status: current
related_packages: ["@namzu/cli", "@namzu/sdk", "@namzu/anthropic", "@namzu/openai", "@namzu/openrouter", "@namzu/ollama"]
---

# namzu CLI

`namzu` is the terminal face of Namzu: an interactive agent in the spirit of Claude Code / Gemini CLI / opencode, built on `@namzu/sdk`. Run `namzu` with no arguments and it launches a TUI — there is no `chat` subcommand.

```bash
namzu            # launch the interactive TUI
namzu --help     # utility subcommands (doctor, providers, …)
```

## What it does

- **Discovers credentials, never asks you to log in.** On first run it finds your LLM provider credentials (env vars, the clawtool secrets file, the macOS Keychain for Claude Code, or a local Ollama) and lets you pick which provider to chat through. See [Providers & credentials](./providers.md).
- **Runs tools, with your approval.** The agent can read files, run shell commands, edit code, search, and more — via the SDK builtins and (when present) the clawtool daemon's catalog. Mutating actions prompt for approval. See [Tools & permission](./tools.md).
- **Remembers across sessions.** Facts in `~/.namzu/USER.md` and `~/.namzu/MEMORY.md` are injected into every turn. See [Memory](./memory.md).
- **Loads skills on demand.** Author `SKILL.md` capability docs and activate them per session. See [Skills](./skills.md).

## Documentation map

| Page | What it covers |
| --- | --- |
| [The TUI](./tui.md) | Launching namzu, the transcript/composer, slash commands, interrupting a turn |
| [Providers & credentials](./providers.md) | How credentials are discovered, the first-run picker, switching providers |
| [Tools & permission](./tools.md) | Builtin tools, the clawtool bridge, and the approve/reject/approve-all prompt |
| [Memory](./memory.md) | `USER.md` / `MEMORY.md` injection, `/remember`, `/memory` |
| [Skills](./skills.md) | `SKILL.md` format, discovery, `/skills`, `/skill <name>` |

## Requirements

- Node.js (the version pinned by the workspace).
- At least one usable LLM credential — see [Providers & credentials](./providers.md). If none is found, namzu tells you exactly what to set.
- Optional: a running `clawtool` daemon to add its tool catalog. namzu works without it.
