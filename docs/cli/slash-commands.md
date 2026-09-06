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

A line starting with `/` is a command. Reports and menus do not call a model;
commands that start work, such as a goal, can start model calls. Builtins win
over command files of the same name in `.namzu/commands/`. `/help`, slash
completion and execution use the same command catalogue. Unavailable actions
explain why they cannot run and are checked again when selected.

| Command | What it does |
| --- | --- |
| `/help` | Search commands and choose an action, including command files. |
| `/settings` | View the current model, reasoning effort and permission mode; open their controls or configuration-source details. |
| `/feedback` | Rate the last answer; choose good/bad or add an optional note. |
| `/clear` | Clear the terminal and start a fresh conversation. |
| `/new` | Start a fresh conversation without clearing the terminal. |
| `/archive` | Archive this conversation and exit after confirmation. |
| `/exit` | Exit namzu. |
| `/rename` | Rename this conversation; opens an editor when no name is supplied. /rename clear removes the saved name. |
| `/fork` | Continue in a copy of this conversation, leaving the original where it is. |
| `/memory` | Show what namzu remembers, or save a fact: /memory [something to remember]. |
| `/skills` | Choose an available skill; use /skills list for the full roster. |
| `/resume` | Resume a past conversation in this project. |
| `/model` | Choose a model for the current provider; use `p` to change provider. The picker states whether the selection is saved for future launches. |
| `/login` | Sign in with a `Claude` or `Codex` subscription. |
| `/logout` | Remove a Namzu-owned subscription credential: `/logout [claude|codex|all]`. |
| `/cost` | Show usage and cost for the current or latest run; `/cost details` adds pricing and scope information. |
| `/jobs` | List background jobs started this session, running and ended. |
| `/release-notes` | Show what changed in the version that is running: /release-notes [version]. |
| `/hooks` | List the shell hooks this session runs, by event. |
| `/context` | Show the latest context measurement and cleanup summary; `/context details` adds thresholds and cleanup counters. |
| `/review` | Choose a review target, or provide custom instructions: /review [instructions]. |
| `/mcp` | Show connection state, tool counts and failures; `/mcp tools` lists tool names. `/mcp details` is equivalent. |
| `/diff` | Show what is uncommitted in this working tree. |
| `/compact` | Summarise the older half of this conversation to free up context. |
| `/copy` | Choose the whole latest answer, a code block, or a quote to copy. |
| `/raw` | Toggle copy-friendly plain transcript rendering: /raw [on\|off]. |
| `/export` | Export this verified conversation to the clipboard or a Markdown file. |
| `/status` | Show model, permissions, workspace and latest cost. `/status details` expands rules and isolation; `/status config` shows setting sources; `/status tools` lists callable tools. |
| `/permissions` | Choose an approval mode; `/permissions details` shows rules and exceptions. Direct modes are `prompt`, `accept-edits`, `auto`, `strict` and `plan`. |
| `/effort` | Choose reasoning effort for future turns: /effort [level\|default]. |
| `/init` | Write an AGENTS.md describing this project to future agents. |
| `/goal` | Open this conversation’s goal menu. `/goal status` reads progress; `/goal set` opens the objective editor. |
| `/tasks` | Read tasks from this conversation’s current or latest run. Starting another run or changing conversations clears the previous selection. |
| `/agents` | Inspect delegated activity in this conversation; `/agents running` opens the same view. `/agents available` lists configured agents. |

## Settings and model changes

On exit, the production CLI prints a resume command with the absolute working
directory and the Node executable and entrypoint that launched it. This keeps
a checkout build’s sessions attached to that build, even when `namzu` on PATH
refers to a different global installation. Embedded hosts without an explicit
launch command use the `namzu` fallback. Copy the full command when resuming
from another directory.

`/settings` shows safe effective values and opens the existing model, effort
and permission controls. It is not a general configuration-file editor and
does not display credentials. `/status config` remains a report of sources;
it deliberately omits resolved values.

A normal `/model` selection applies to this session and future launches.
Selections using a temporary typed credential stay in this session. Changing
the primary model preserves unrelated preferences, configured subagents and
fallback models, removing an exact duplicate of the new primary from the
fallback list. The replacement session must construct successfully before
saved preferences change. A cancelled or failed switch leaves the previous
session usable. A successful model switch resets the session’s effort override
to the new model’s default.

`/effort` and `/permissions` affect future turns in the current TUI session.
The effort choices depend on the selected model and usable fallback models.
Changing any permission mode clears a previous “approve all” choice. Explicit
deny rules and built-in safety checks still apply; `plan` additionally blocks
writes even when a rule would allow them.

## Goals and task scope

`/goal` opens actions appropriate to the saved goal. `/goal set` and
`/goal edit` open objective editors; `/goal set <objective>` and
`/goal edit <objective>` supply the text directly. `/goal status` only reads
the goal. `/goal pause`, `/goal resume` and `/goal clear` control automatic
continuation. Direct `/goal <objective>` input also remains supported.

Creating or resuming a goal enables automatic work. The menu and objective
editor show the automatic-turn allowance before submission. Pausing or
clearing prevents further automatic turns; it does not undo a running tool
call or interrupt the current turn. Goal reports distinguish the saved status
from whether automatic continuation is enabled or paused.

`/tasks` reads the actual run task store, including updates made without a
visible task event. Before a run has supplied a list, it reports that no task
list is available yet. A run with an empty store reports an empty list.
Switching conversations forgets the selected list without deleting stored
tasks. The command does not search unrelated historical runs. An embedded
session that does not expose task storage reports that listing is unavailable.

Usage and cost are also scoped to the current or latest run, not the whole
conversation. Own model-call cost is separate from token totals that include
delegated agents. Unknown prices remain unknown, partly priced usage is a
lower bound, and measured zero is shown distinctly.

## Picker navigation

Command, settings, goal, skill, branch and commit menus support typing to
filter. In searchable menus digits are search text, not immediate selection
shortcuts. Arrow keys navigate; Enter applies the selected available action.
Esc goes back or closes the current surface while preserving the composer’s
draft. Non-searchable menus retain their displayed numeric shortcuts.
Current and default markers are separate from descriptions, and narrow
terminals place descriptions below labels.

## Keys that are not commands

- **Esc Esc** on an empty composer opens the picker of earlier prompts. Picking one forks the conversation before that prompt and reopens it for editing; the original conversation is left where it was.
- **Esc** while a turn runs interrupts it. **Ctrl+C** is reserved for exit.
- **Shift+Tab** cycles the permission mode: `prompt`, `accept-edits`, `plan`.
- **Ctrl+O** expands collapsed tool output that is still on screen.
- **Ctrl+T** opens or closes delegated activity, also reachable with `/agents`.
- **`!command`** runs on the host without the model; **`#note`** remembers. See [The composer prefixes](composer-prefixes.md).
