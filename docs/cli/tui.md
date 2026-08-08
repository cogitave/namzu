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

1. **Trust.** The first time you run namzu in a folder it asks whether you trust the files there (it can read, run commands in, and edit them). Press **`y`** to trust it, **`n`** or **`Esc`** to exit. Trusted folders are remembered in `~/.namzu/trust.json` and the trust covers every subfolder. See [Tools & permission](./tools.md).

   **`Enter` does not grant trust**, and `y` is ignored for a moment after the gate appears. You reach this screen by pressing Enter to launch namzu, so a key repeat or an impatient second press arrives while it is still drawing — and what it would have granted is durable. Refusing is never delayed: `n`, `Esc` and `Ctrl+C` exit on the first press.
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
| `/model` | Choose the provider, then the model. See [Switching model](#switching-model). |
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

You can add your own — see [Your own slash commands](#your-own-slash-commands).

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

### Switching model

`/model` asks two questions: which provider, then which model. Enter accepts,
`esc` steps back to the provider list rather than out of the picker. The model
step starts on the one already in force, so re-opening it does not quietly reset
you to the default.

The list comes from the provider itself, and it is not always available. When it
is not, the picker says which of these happened rather than showing an empty
list:

| What you see | What it means |
| --- | --- |
| the models | the provider answered |
| *did not answer in time* | it was still thinking after 3 seconds — retryable |
| *returned no models* | it answered, with none |
| *does not publish a model list* | this driver has no listing capability |
| *could not list models: …* | it errored, with its own reason |

In every one of those cases the provider's default is still offered and
selectable, so the step is never a dead end. The default is marked `(default)`
wherever it appears.

Your choice is written to `~/.namzu/preferences.json` as the primary entry's
`model`, and it is what the next turn is sent with. See
[the provider chain](./providers.md#the-provider-chain) for the file's shape.

## Your own slash commands

A markdown file becomes a command. The body is the prompt it sends.

```
~/.namzu/commands/<name>.md      available in every project
<cwd>/.namzu/commands/<name>.md  this project only
```

`review.md` becomes `/review`. A project command shadows a user command of the
same name, the same precedence [skills](./skills.md) use. Frontmatter is
optional and only `description` is read — it is what `/help` and the
autocomplete dropdown show.

```markdown
---
description: Review a file for unchecked errors
---

Read $ARGUMENTS and list every place an error is swallowed or ignored.
Quote the line. Do not suggest fixes yet.
```

### Arguments

`$ARGUMENTS` is replaced by whatever followed the command, so
`/review src/parse.ts` sends the template with the path substituted. Every
occurrence is replaced; with no arguments it becomes empty.

**A template with no `$ARGUMENTS`, invoked with arguments, is refused.** It
names the file and tells you to add the token. This is deliberate: running it
would discard what you typed, and a command that silently ignores half its
input is worse than one that stops. A template with no `$ARGUMENTS` and no
arguments is a static prompt and runs normally.

The refusal is the reversible choice. Relaxing it later — appending the
arguments somewhere — breaks nobody, while going the other way would break
everyone who had come to rely on the looser behaviour.

### When a file will not load

A command whose frontmatter cannot be parsed is refused, not skipped. It still
appears in `/help` marked `⚠` with the parse error, so a file you can see on
disk is accounted for, and the other commands keep working. A file named after a
built-in — `help.md` — is likewise listed with its reason rather than silently
ignored; built-ins always win.

Files are read when the session starts. After adding one, `/model` or a restart
picks it up.

### They work in scripts too

`namzu run` and `namzu run-stream` expand your commands the same way, which is
most of the reason to write one:

```bash
namzu run "/review src/parse.ts"
```

**A leading `/` is not enough to make something a command.** `namzu run
"/usr/local/bin is missing"` is an ordinary prompt and is sent as written. What
makes it a command is the first word naming one your project actually declares —
a file in `.namzu/commands/` is an explicit declaration, while a word that
happens to start with a slash is not.

Built-in commands are interactive and do nothing headless. `namzu run "/help"`
is refused with a message rather than sent, because nobody means that string
literally. But `namzu run "/clear the cache in redis"` is a request and passes
through untouched — the extra words are what tell the two apart.

A command that refuses — arguments it cannot receive, or frontmatter that will
not parse — exits non-zero and prints the reason. It is never sent as prose:
the run failing is the point, since a script that continues on a misfired
command is the thing worth preventing.

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

A draft you have not sent survives whatever the agent does. If a permission prompt appears mid-sentence it takes the screen, and your text — along with any pasted-text or image attachments — comes back untouched when the prompt is answered. Pressing `Esc` to interrupt a running turn interrupts only; it does not clear what you were typing. With nothing running, `Esc` clears the composer.

## Expanding tool output

Tool diffs and command output collapse to a few lines with a `… +N lines (ctrl+o to expand)` hint. Press **Ctrl+O** to toggle full expansion for everything.

## Sessions & resume

Every conversation is persisted (via the SDK session store) under the folder's `.namzu`. `/resume` opens a picker of the folder's recent conversations (title + relative time): ↑/↓ navigate, Enter restores the transcript and continues in that session, Esc cancels.

## Interrupting and exiting

`Ctrl+C` is context-aware:

- **While the agent is working** — the first `Ctrl+C` interrupts the current turn (aborts the in-flight run). It does not exit.
- **While a permission prompt is open** — `Ctrl+C` rejects the pending tool call and aborts the turn.
- **While idle** — press `Ctrl+C` twice to exit (a single press arms exit and prints a reminder).
