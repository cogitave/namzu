---
title: CLI
description: namzu is a terminal AI agent — a TUI that discovers your LLM credentials, runs tools under a permission model you choose, and remembers context across sessions.
last_updated: 2026-08-06
status: current
related_packages: ["@namzu/cli", "@namzu/sdk", "@namzu/anthropic", "@namzu/openai", "@namzu/openrouter", "@namzu/ollama"]
---

# namzu CLI

`namzu` is the terminal face of Namzu: an interactive agent in your terminal, built on `@namzu/sdk`. Run `namzu` with no arguments and it launches a TUI — there is no `chat` subcommand.

```bash
namzu                      # launch the interactive TUI
namzu run "fix the build"  # headless one-shot — prints the reply (for scripts/CI)
echo "..." | namzu run     # prompt from stdin
namzu --format json run "fix the build"        # reply as {"text": "..."}
namzu run --cwd ../other "which tests fail?"   # work in another checkout
namzu run --continue "and now the e2e suite"   # reopen the last conversation here
namzu --help               # utility subcommands (doctor, providers, run, …)
```

`--format` and `--quiet` are program-level options and go **before** the
subcommand. `run` and `run-stream` refuse an option they do not recognize
rather than treating it as prompt text, so `namzu run --format json "…"` exits
`64` — see [Headless runs](./headless.md#options).

## What it does

- **Discovers credentials, never asks you to log in.** On first run it finds your LLM provider credentials (env vars, an OAuth credential in the macOS Keychain, or a local Ollama) and lets you pick which provider to chat through. See [Providers & credentials](./providers.md).
- **Runs tools, under a permission model you choose.** The agent reads files, runs shell commands, edits code, searches, tracks a plan, and remembers — via the SDK builtins plus its memory and task tools. Mutating actions prompt for approval in the TUI; a headless run approves them unless you ask for `--permission-mode strict`. A safety gate hard-denies catastrophic commands in every mode. See [Tools & permission](./tools.md).
- **Connects to your own tool servers.** Declare them in `namzu.config.json` and their tools join the agent's roster under the server's name. A server that does not come up is named, with the reason, rather than quietly missing. See [External tool servers](./tool-servers.md).
- **Follows the project's own instructions.** An `AGENTS.md` in the working directory — and in every directory up to the repository root — is loaded into the agent's context and followed as standing policy for work in that project. namzu names the files it loaded, so you can tell it read them. See [Project instructions](./project-instructions.md).
- **Remembers across sessions.** User facts in `~/.namzu/USER.md` / `MEMORY.md` are injected every turn; the agent also keeps its own structured memory. See [Memory](./memory.md).
- **Resumes past conversations.** Every conversation is saved. `/resume` continues a previous one in this folder from the TUI; `namzu run --continue` and `--resume <id>` do the same from a script. Neither ever silently starts a fresh conversation when the one you asked for cannot be reopened.
- **Loads skills on demand.** Author `SKILL.md` capability docs and activate them per session. See [Skills](./skills.md).
- **Polished TUI.** Markdown-rendered replies, tool diffs that collapse to a numbered hint you can reopen with `/expand`, slash-command autocomplete, message queuing, and paste handling. See [The TUI](./tui.md).

## Documentation map

| Page | What it covers |
| --- | --- |
| [The TUI](./tui.md) | Header, transcript/composer, slash commands + autocomplete, queuing, `/resume`, `/expand`, interrupting |
| [Headless runs](./headless.md) | `run` and `run-stream`, their shared options, `--cwd`, permission modes, resuming, exit codes, the NDJSON event stream |
| [`namzu doctor`](./doctor.md) | What it checks, the five status words, and what each exit code tells a script — including the one that says a check could not answer |
| [Providers & credentials](./providers.md) | How credentials are discovered, the first-run picker, switching providers |
| [Tools & permission](./tools.md) | Builtin + memory + task tools, deferred tools and `search_tools`, how a call is decided, permission modes, the safety gate, bypass mode |
| [External tool servers](./tool-servers.md) | Declaring tool servers in `namzu.config.json`, naming, failures, lifetime |
| [Project instructions](./project-instructions.md) | `AGENTS.md` discovery from the working directory upward, ordering and overrides, limits |
| [Memory](./memory.md) | `USER.md` / `MEMORY.md` injection, `/remember`, `/memory`, the agent's structured memory |
| [Skills](./skills.md) | `SKILL.md` format, discovery, `/skills`, `/skill <name>` |

## Requirements

- Node.js (the version pinned by the workspace).
- At least one usable LLM credential — see [Providers & credentials](./providers.md). If none is found, namzu tells you exactly what to set.

Nothing else needs to be running. A namzu run is an ordinary process; there is no daemon to start first.
