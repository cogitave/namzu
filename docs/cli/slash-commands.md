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
| `/help [command]` | Search commands and choose an action, or read one command's usage without running it. |
| `/setup` | Check optional Codex, Claude Code and OpenCode installations separately from credential availability. Confirm an npm installation, cancel it, recheck, or open provider connection. |
| `/config`, `/settings` | View the current model, reasoning effort and permission mode; open their controls or configuration-source details. |
| `/feedback` | Rate the last answer; choose good/bad or add an optional note. |
| `/clear` | Clear the terminal and start a fresh conversation. |
| `/new` | Start a fresh conversation without clearing the terminal. |
| `/archive` | Archive this conversation and exit after confirmation. |
| `/exit` | Exit namzu. |
| `/rename` | Rename this conversation; opens an editor when no name is supplied. /rename clear removes the saved name. |
| `/fork` | Continue in a copy of this conversation, leaving the original where it is. |
| `/memory` | Show curated memory; `/memory show` and `/memory list` also inspect it. `/memory add <text>` saves a project fact; put `--user` before `add` to save a user fact. |
| `/skills` | Choose an available skill; use /skills list for the full roster. |
| `/resume` | Resume a past conversation in this project. |
| `/model` | Choose a model for the current provider, then its reasoning effort when supported. Other detected providers are named above the list; press `p` to switch providers. The picker states whether the model selection is saved for future launches. |
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
| `/permissions` | Choose Ask before changes, Auto-approve edits or Plan (read-only). More options contains Auto-approve tools, Preapproved tools only and View rules. |
| `/effort` | Choose reasoning effort for future turns: /effort [level\|default]. |
| `/init` | Write an AGENTS.md describing this project to future agents. |
| `/goal` | Open this conversation’s goal menu. `/goal status` reads progress; `/goal set` opens the objective editor. |
| `/tasks` | Read tasks from this conversation’s current or latest run. Starting another run or changing conversations clears the previous selection. |
| `/agents` | Inspect delegated activity in this conversation; `/agents running` opens the same view. `/agents available` lists configured agents. |

## Command-specific help

Bare `/help` opens the searchable command picker. `/help permissions` and
`/help /permissions` instead show that command's usage, description and any
reason it is currently unavailable. Reading help does not invoke the target
command. Names match exactly and are case-sensitive, as they are during
execution. An unknown name or multiple target words produces guidance rather
than opening or running another command.

CLI command usage is declared alongside its action. Kernel commands retain
their descriptor's hint and show `[arguments]` when the descriptor provides an
argument schema; help does not invent positional arguments or flags from that
schema.

For a user command file, help shows its full source path and scope, plus any
problem that prevents execution. Its usage includes `[arguments]` only when
the template contains `$ARGUMENTS`. Help does not expand or execute the template.

## Settings and model changes

On exit, the production CLI prints a resume command with the absolute working
directory and the Node executable and entrypoint that launched it. This keeps
a checkout build’s sessions attached to that build, even when `namzu` on PATH
refers to a different global installation. Embedded hosts without an explicit
launch command use the `namzu` fallback. Copy the full command when resuming
from another directory.

`/config` (also available as `/settings`) shows Model, Reasoning effort and
Permissions with their effective values, and opens the corresponding controls.
Setting sources opens provenance details; `/config sources` opens it directly.
Web & session opens the bounded `/status` card with the current search backend,
workspace, model and usage. The status snapshot is rendered as an Ink card with aligned label/value columns,
stacking on narrow terminals. Full paths wrap rather than being truncated.
The plain-text snapshot remains available in raw mode. It reports known runtime
usage, not an inferred subscription quota.
Its permission value includes a previous approval of all tools for the session.
It is not a general configuration-file editor and
does not display credentials. `/status config` remains a report of sources;
it deliberately omits resolved values.

A normal `/model` selection applies to this session and future launches.
Selections using a temporary typed credential stay in this session. Changing
the primary model preserves unrelated preferences, configured subagents and
fallback models, removing an exact duplicate of the new primary from the
fallback list. The replacement session must construct successfully before
saved preferences change. A cancelled or failed switch leaves the previous
session usable. A successful model switch resets the session’s effort override
to the new model’s default. After an interactive model choice, a non-empty
supported effort menu opens for the new session. Enter applies the selected
effort for this session; Esc keeps the successfully selected model at its default
effort. Queued work waits until this step closes. Models with no supported effort
choices, or no known exact menu, return directly to the composer. `/effort`
remains available to change effort later.

Standalone `/model <ID>`, “modeli opus-5 yapar mısın” and
“gpt-5.6 lunaya geçer misin” are host selections: they resolve the detected
catalogues without sending the request to the model. The composer previews the
requested model before Enter. Exact IDs win; a unique complete suffix such as
`opus-5` can resolve to `claude-opus-5`. Ambiguous selections require an explicit
provider or the picker. These selections preserve history and saved defaults.
Attachments and requests mixing model selection with other work remain ordinary
prompts. Active work must settle before a direct host selection can apply.

The composer also previews `/effort <level>` against the current session's
published menu, marking unsupported values unavailable. Preview is not application.
`ultracode` is not an alias for an effort level; available levels come from the
provider. See [OpenAI reasoning menus](../sdk/openai-reasoning.md) for Astra's
different API and subscription menus.

You can also ask for a change within a larger conversation request, for example
“gpt-5.6-luna’ya geç”. In response to an explicit request, the interactive
agent can call `switch_model` with `model` and optional `provider`, using
exact catalogue and provider registry IDs. It checks the usable
provider catalogues and prefers the current provider when that provider
offers the requested model. If the ID matches multiple other providers,
the request is refused with choices so you can specify the provider.
A unique usable provider can be selected automatically. Names are not
fuzzy-matched or inferred from prefixes; unavailable models do not change
the current session. On a missing ID, up to eight recovery choices are ranked
by overlap with the requested model's name before the list is bounded. A partial
family name never silently selects a variant.

A successful tool result means the switch is queued. Called alone, this
terminal tool ends the current turn without another model inference. A failed
request still returns to the model for correction; a mixed tool batch retains
the kernel's normal result-relay behavior. Repeating the same accepted request
reuses its reservation. The current turn saves its results before the
replacement is prepared and applied. The terminal confirms the new model
only after application succeeds. Conversation identity and message history
are retained, and a successful switch resets reasoning effort to the new
model’s default. Cancelling the turn, leaving the conversation, or failing
to prepare the replacement leaves the existing model in place. A switch
is refused while delegated agents or background jobs are still running.

Conversational switches affect only this session; they do not change saved
defaults for later launches. The `switch_model` tool is available only to
the main interactive agent, not headless runs or delegated agents.

`/effort` and `/permissions` affect future turns in the current TUI session.
The effort choices depend on the selected model and usable fallback models.
Changing any permission mode clears a previous “approve all” choice. Explicit
deny rules and built-in safety checks still apply; `plan` additionally blocks
writes even when a rule would allow them.

The permission menu shows the effective current behavior, including any earlier
approval of all tools. More options keeps automatic approval and preapproved-only
execution available without placing their internal mode names in the main menu.
Esc returns from More options without applying a change. The approval prompt's
second choice explicitly allows **all tools for this session**, not just the
displayed operation. Configured rules and sandbox restrictions still apply.
For typed shortcuts, `/permissions prompt`, `accept-edits`, `auto`, `strict`
and `plan` remain accepted. `/permissions details` opens the rule report directly.

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

The model picker filters the current provider's catalogue by model ID and
display name as you type. Search ignores case and matches every typed word.
Press `/` to start search explicitly, including a query beginning with `p` or
a number. Before search starts, `p` changes provider and numbers select a row;
while searching they are ordinary text. Left arrow always changes provider.
Backspace removes a character and Ctrl+U clears the search. A selected model
stays selected when it still matches, and current/default markers remain visible.
Arrows, PgUp/PgDn and Home/End move through the filtered results. Enter applies
the highlighted model; an empty result cannot be applied. Esc retains its
normal back or cancel behavior, including cancelling a pending selection.

In `/agents`, Enter opens the selected child's live transcript as a separate
framed screen. Esc returns to the agent list; `q` or Ctrl+T returns to the main
conversation. Completed children remain available while retained in this
session, even after their automatic activity rail disappears.

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
- **Ctrl+O** expands small tool output in place. Older or oversized output opens a bounded viewer without appending transcript copies. Use ↑↓ or PgUp/PgDn to scroll, ←→ to switch retained outputs, g/G for the beginning/end, and Esc, q or Ctrl+O to close.
- **Ctrl+T** opens or closes delegated activity, also reachable with `/agents`.
- **`!command`** runs on the host without the model; **`#note`** remembers. See [The composer prefixes](composer-prefixes.md).

### Resuming a conversation

`/resume` derives unnamed conversation titles from the first authored prompt,
not project instructions. Old derived `Conversation` placeholders are replaced
in the list when the original prompt is still available; deliberately chosen
names are preserved. On terminals at least 20 rows high, the selected row shows
the last authored prompt, saved message count and full conversation UUID. Short
terminals retain the compact list so navigation remains visible.

When an active or paused goal is present after opening a saved conversation,
Namzu offers **Resume goal** or **Not now**. Opening history alone does not arm
automatic work. Choosing Resume uses the existing `/goal resume` path and its
budget checks; dismissing the picker leaves automatic work stopped. Completed
or blocked goals are not automatically offered for continuation.

Provider setup is also reachable with `s` in the provider picker. Namzu does not
require an external CLI for its own Codex/Claude sign-in or anonymous Zen models.
The setup screen probes `--version` with bounded subprocesses and displays only
credential source kinds, never credentials. `i` proposes the exact npm global
install command for a missing CLI; only `y` on that confirmation runs it.
Installation can execute third-party package scripts. Escape cancels the owned
installer process group; files already installed may remain. After it finishes,
Namzu checks the executable again. `c` opens connection/model selection with
fresh credential discovery. Installation success does not establish sign-in or
account quota. npm must already be available on PATH; failures remain visible.

Installation recipes use the published package names from
[Codex](https://www.npmjs.com/package/@openai/codex),
[Claude Code](https://support.claude.com/en/articles/14552382-your-first-day-in-claude-code),
and [OpenCode](https://opencode.ai/docs/).

### Installation identity

`/status` shows the owning CLI package version, absolute CLI entrypoint, and a
16-character SHA-256 fingerprint of its executable CLI files. The fingerprint
is cached on first use; restart after updating files. It identifies CLI file
content, not a Git commit or the contents of dependency packages. This lets two
installations with the same version number be distinguished without reading
credentials or contacting a provider.
