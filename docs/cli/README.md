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
namzu                      # launch the interactive TUI
namzu run "fix the build"  # headless one-shot — prints the reply (for scripts/CI)
echo "..." | namzu run     # prompt from stdin; add --format json for {"text": "..."}
namzu --help               # utility subcommands (doctor, providers, run, …)
```

## What it does

- **Discovers credentials, never asks you to log in.** On first run it finds your LLM provider credentials (env vars, the clawtool secrets file, the macOS Keychain for Claude Code, or a local Ollama) and lets you pick which provider to chat through. See [Providers & credentials](./providers.md).
- **Runs tools, with your approval.** The agent reads files, runs shell commands, edits code, searches, tracks a plan, and remembers — via the SDK builtins plus (deferred, on demand) the clawtool catalog. Mutating actions prompt for approval; a safety gate hard-denies catastrophic commands. See [Tools & permission](./tools.md).
- **Remembers across sessions.** User facts in `~/.namzu/USER.md` / `MEMORY.md` are injected every turn; the agent also keeps its own structured memory. See [Memory](./memory.md).
- **Resumes past conversations.** Every conversation is saved; `/resume` continues a previous one in this folder.
- **Loads skills on demand.** Author `SKILL.md` capability docs and activate them per session. See [Skills](./skills.md).
- **Polished TUI.** Markdown-rendered replies, collapsible tool diffs (Ctrl+O), slash-command autocomplete, message queuing, and paste handling. See [The TUI](./tui.md).

## Documentation map

| Page | What it covers |
| --- | --- |
| [The TUI](./tui.md) | Header, transcript/composer, slash commands + autocomplete, queuing, `/resume`, Ctrl+O, interrupting |
| [Providers & credentials](./providers.md) | How credentials are discovered, the first-run picker, switching providers |
| [Tools & permission](./tools.md) | Builtin + memory + task tools, deferred clawtool, the permission prompt, the safety gate, bypass mode |
| [Memory](./memory.md) | `USER.md` / `MEMORY.md` injection, `/remember`, `/memory`, the agent's structured memory |
| [Skills](./skills.md) | `SKILL.md` format, discovery, `/skills`, `/skill <name>` |

## Requirements

- Node.js (the version pinned by the workspace).
- At least one usable LLM credential — see [Providers & credentials](./providers.md). If none is found, namzu tells you exactly what to set.
- Optional: a running `clawtool` daemon to add its tool catalog. namzu works without it.
