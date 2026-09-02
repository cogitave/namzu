---
type: Reference
title: Slash commands
description: Every builtin slash command the interactive session answers to, one line each, with the composer keys that are not commands — Esc Esc, Shift+Tab, `!`, `#`.
resource: packages/cli/src/tui/slashCommands.ts
tags: [cli, commands, composer]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-02T00:00:00Z }
---

# Slash commands

A line starting with `/` is a command, answered by the session without a model call unless the command itself starts a turn. Builtins win over a command file of the same name in `.namzu/commands/`; `/help` opens a picker over the whole vocabulary, files included.

| Command | What it does |
| --- | --- |
| `/help` | Choose and run an available slash command. |
| `/feedback` | Rate the last answer; choose good/bad or add an optional note. |
| `/clear` | Clear the terminal and start a fresh conversation. |
| `/new` | Start a fresh conversation without clearing the terminal. |
| `/archive` | Archive this conversation and exit after confirmation. |
| `/exit` | Exit namzu. |
| `/rename` | Rename this conversation; opens an editor when no name is supplied. /rename clear removes the saved name. |
| `/fork` | Continue in a copy of this conversation, leaving the original where it is. |
| `/memory` | Show what namzu remembers, or save a fact: /memory [something to remember]. |
| `/skills` | Choose an available skill; use /skills list for the full roster. |
| `/resume` | Resume a past conversation in this folder. |
| `/model` | Re-open the provider picker to switch the primary provider. |
| `/login` | Sign in with a `Claude` or `Codex` subscription. |
| `/logout` | Remove a Namzu-owned subscription credential: `/logout [claude|codex|all]`. |
| `/cost` | Show tokens and spend for this run. |
| `/jobs` | List background jobs started this session, running and ended. |
| `/release-notes` | Show what changed in the version that is running: /release-notes [version]. |
| `/hooks` | List the shell hooks this session runs, by event. |
| `/context` | Show how full the context is and what compaction has done to keep it that way. |
| `/review` | Choose a review target, or provide custom instructions: /review [instructions]. |
| `/mcp` | Show current tool-server connections, tools, and failures. |
| `/diff` | Show what is uncommitted in this working tree. |
| `/compact` | Summarise the older half of this conversation to free up context. |
| `/copy` | Choose the whole latest answer, a code block, or a quote to copy. |
| `/raw` | Toggle copy-friendly plain transcript rendering: /raw [on\|off]. |
| `/export` | Export this verified conversation to the clipboard or a Markdown file. |
| `/status` | Show what this session is, where it may write, and when it stops to ask; /status config for where each setting came from, /status tools for what the agent can call. |
| `/permissions` | Choose how undecided tool calls are handled: /permissions [mode]. |
| `/effort` | Choose reasoning effort for future turns: /effort [level\|default]. |
| `/init` | Write an AGENTS.md describing this project to future agents. |
| `/goal` | Persist or inspect a completion goal for this conversation. |
| `/tasks` | List the work this run is tracking. |
| `/agents` | List the agents this run may delegate to. |

## Keys that are not commands

- **Esc Esc** on an empty composer opens the picker of earlier prompts. Picking one forks the conversation before that prompt and reopens it for editing; the original conversation is left where it was.
- **Esc** while a turn runs interrupts it. **Ctrl+C** is reserved for exit.
- **Shift+Tab** cycles the permission mode: `prompt`, `accept-edits`, `plan`.
- **Ctrl+O** expands collapsed tool output that is still on screen.
- **`!command`** runs on the host without the model; **`#note`** remembers. See [The composer prefixes](composer-prefixes.md).
