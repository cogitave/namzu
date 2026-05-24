---
title: The TUI
description: Launching namzu, the transcript and composer, slash commands, and interrupting a running turn.
last_updated: 2026-05-25
status: current
related_packages: ["@namzu/cli"]
---

# The TUI

Running `namzu` with no arguments launches an interactive terminal UI built with Ink. There is intentionally no `chat` subcommand — the bare command *is* the chat surface. Utility subcommands (e.g. `namzu doctor`) remain available via `namzu --help`.

## Lifecycle

1. **Probe.** On launch namzu reads your saved provider choice (`~/.namzu/preferences.json`) and discovers available credentials.
2. **Pick (first run only).** If you haven't chosen a provider — or none can be auto-selected — the provider picker appears. See [Providers & credentials](./providers.md).
3. **Ready.** Once a provider is connected, the transcript opens and the composer accepts input. The connect line reports the provider, model, and how many tools are available.

## Layout

- **Transcript** — the scrolling conversation. Each entry has a role glyph: `▸ you`, `◆ namzu`, `⚙ tool` (a tool the agent ran), and `⚠ system` (status/errors). A pending reply shows an animated spinner.
- **Composer** — the input box at the bottom. It's disabled while the agent is working.
- **Status bar** — shows the working directory, provider/model, current state, and a contextual hint.

## Slash commands

Type `/` followed by a command. `/help` lists everything available.

| Command | Effect |
| --- | --- |
| `/help` | List all slash commands. |
| `/clear` | Clear the transcript. |
| `/tools` | List the tools the agent can call (builtins + clawtool). |
| `/provider` | Show the current provider and model. |
| `/model` | Re-open the provider picker to switch providers. |
| `/remember <text>` | Save a fact to durable memory. See [Memory](./memory.md). |
| `/memory` | Show what namzu remembers. |
| `/skills` | List available skills. See [Skills](./skills.md). |
| `/skill <name>` | Activate a skill for this session. |
| `/quit`, `/exit` | Leave namzu. |

Anything that isn't a slash command is sent to the agent as a message.

## Interrupting and exiting

`Ctrl+C` is context-aware:

- **While the agent is working** — the first `Ctrl+C` interrupts the current turn (aborts the in-flight run). It does not exit.
- **While a permission prompt is open** — `Ctrl+C` rejects the pending tool call and aborts the turn.
- **While idle** — press `Ctrl+C` twice to exit (a single press arms exit and prints a reminder).

This mirrors other coding agents: stop the work first, leave only when there's nothing running.
