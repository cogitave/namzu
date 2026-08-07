---
title: The TUI
description: Launching namzu, the transcript and composer, slash commands, message queuing, /resume, and interrupting a running turn.
last_updated: 2026-08-07
status: current
related_packages: ["@namzu/cli"]
---

# The TUI

Running `namzu` with no arguments launches an interactive terminal UI built with Ink. There is intentionally no `chat` subcommand — the bare command *is* the chat surface. Utility subcommands (e.g. `namzu doctor`) remain available via `namzu --help`.

On launch namzu clears the screen and greets you with a header: the namzu mascot (a bloom over a little face, in the teal/green brand color) beside `Cogitave Namzu`, the version, the connected provider · model, and the working directory.

## Lifecycle

1. **Trust.** The first time you run namzu in a folder it asks whether you trust the files there (it can read, run commands in, and edit them). Trusted folders are remembered. See [Tools & permission](./tools.md).
2. **Probe.** namzu reads your saved provider choice (`~/.namzu/preferences.json`) and discovers available credentials.
3. **Pick (first run only).** If you haven't chosen a provider — or none can be auto-selected — the provider picker appears. See [Providers & credentials](./providers.md).
4. **Ready.** The transcript opens and the composer accepts input. The connect line reports the provider, model, and the number of active tools.

## Layout

- **Transcript** — the scrolling conversation. Roles read from a glyph gutter: `>` you, `✦` namzu, `⏺` a tool call (with a `⎿` result line beneath it), `☐`/`☑` plan todos, `·` system notes. Assistant replies render **markdown** — headings, **bold**, `inline code`, code blocks, bullet/numbered lists, tables, and links. A pending reply shows a braille spinner.
- **Composer** — the input field (a rounded rule with a `>` prompt). Typing `/` opens a command autocomplete dropdown (↑/↓ navigate, Tab complete, Enter run). Pasting a large/multi-line block holds it as a `⎘ Pasted text #N` chip instead of flooding the input.
- **Status bar** — working directory, provider/model, token usage (and cost when priced), current state, and a contextual hint.

## Slash commands

Type `/` followed by a command — an autocomplete dropdown filters as you type. `/help` lists everything.

| Command | Effect |
| --- | --- |
| `/help` | List all slash commands. |
| `/clear` | Clear the transcript. |
| `/tools` | List the tools the agent can call. |
| `/provider` | Show the current provider and model. |
| `/model` | Re-open the provider picker to switch providers. |
| `/resume` | Pick a past conversation in this folder to continue. See [Sessions & resume](#sessions--resume). |
| `/remember <text>` | Save a fact to durable memory. See [Memory](./memory.md). |
| `/memory` | Show what namzu remembers. |
| `/skills` | List available skills. See [Skills](./skills.md). |
| `/skill <name>` | Activate a skill for this session. |
| `/cost` | Tokens and spend for this run. See [What `/cost` is counting](#what-cost-is-counting). |
| `/permissions` | How tool calls get approved, and the rules in force. See [Tools & permission](./tools.md). |
| `/agents` | The delegates this session can dispatch to. |
| `/init` | Write an `AGENTS.md` describing this project. See [Project instructions](./project-instructions.md). |
| `/quit`, `/exit` | Leave namzu. |

Anything that isn't a slash command is sent to the agent as a message.

### What `/cost` is counting

`/cost` reports **cumulative spend for the run** — every token across every
turn, and what it cost. It only ever grows.

That is not how full the context is. Context goes *down* when the conversation
is compacted, and the two are separate quantities that answer different
questions. They were conflated once here: a gauge divided cumulative spend by a
guessed window, so it climbed with turn count and read full on a conversation
with room to spare. `/cost` names which one it is printing for that reason.

Where the status bar abbreviates (`12.3k tok`), `/cost` prints the figure
(`12,345`) — you asked on purpose, so you get the number. A provider that
reports no price shows `$0.0000 (this provider reported no price)` rather than
implying the run was free.

### What `/init` does, and what it will not do

`/init` asks the agent to read the repository and write an `AGENTS.md` for it.
It is a turn, not a template: the file is written by something that has actually
opened the tree, and the instruction it is given asks for every claim to be
verified and for anything unestablished to be left out. An `AGENTS.md` of
plausible inventions is worse than none, because the next agent obeys it.

If project instructions are already loaded, `/init` names them and proposes
edits instead of overwriting. It needs a provider, and says so if there is none.

## Message queuing

The composer stays editable while the agent is working. If you send a message mid-turn it's queued (a `⏎ N messages queued` hint shows) and sent automatically when the current turn settles — queued messages run one at a time, in order.

## Expanding tool output

Tool diffs and command output collapse to a few lines with a `… +N lines (ctrl+o to expand)` hint. Press **Ctrl+O** to toggle full expansion for everything.

## Sessions & resume

Every conversation is persisted (via the SDK session store) under the folder's `.namzu`. `/resume` opens a picker of the folder's recent conversations (title + relative time): ↑/↓ navigate, Enter restores the transcript and continues in that session, Esc cancels.

## Interrupting and exiting

`Ctrl+C` is context-aware:

- **While the agent is working** — the first `Ctrl+C` interrupts the current turn (aborts the in-flight run). It does not exit.
- **While a permission prompt is open** — `Ctrl+C` rejects the pending tool call and aborts the turn.
- **While idle** — press `Ctrl+C` twice to exit (a single press arms exit and prints a reminder).
