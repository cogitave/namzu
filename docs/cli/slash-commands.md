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

A command that answers on the spot is shown as typed (`› /cost`) with its
answer hung under it (`⎿`), so a readout in the scrollback says which command
it answers. A command that composes a message for the model also shows what you typed;
only the model receives the rewritten sentence. The `/help` list shows each description up to its first
clause, so no line ends mid-sentence.

| Command | What it does |
| --- | --- |
| `/help [command]` | Search commands and choose an action, or read one command's usage without running it. |
| `/setup` | Check optional Codex, Claude Code and OpenCode installations separately from credential availability. Confirm an npm installation, cancel it, recheck, or open provider connection. |
| `/config`, `/settings` | View and edit model, reasoning effort, permission mode and turn limits; inspect configuration sources. `/config triggers on\|off` switches [composer triggers](composer-triggers.md) in your user config; `/config triggers` lists what is in force. `/config motion on\|off` switches [reduced motion](themes.md). |
| `/feedback` | Rate the last answer; choose good/bad or add an optional note. |
| `/clear` | Clear the terminal and start a fresh conversation. |
| `/new` | Start a fresh conversation without clearing the terminal. |
| `/archive` | Archive this conversation and exit after confirmation. |
| `/unarchive` | List this project's archived conversations, restore one and open it. Older archived conversations can be found with `namzu archive list --page <n>` and restored by id. |
| `/exit` | Exit namzu. |
| `/rename` | Rename this conversation; opens an editor when no name is supplied. /rename clear removes the saved name. |
| `/fork` | Continue in a copy, leaving the original unchanged. |
| `/worktree` | List or create [managed Git worktrees](worktrees.md), copy this settled conversation into a new checkout, or print how to open one. |
| `/memory` | Show stored memory (the index and, in its own section, what turns recorded) and curated memory; `/memory show` and `/memory list` also inspect it. `/memory add <text>` saves a typed project memory (`--type user\|feedback\|project\|reference` after `add` picks the type); put `--user` before `add` to append a user fact to the curated file. `/memory import-notes` copies the top-level bullets of the project's curated `MEMORY.md` into typed memory files, skipping any already stored, and never changes that file. |
| `/skills` | Choose a skill to activate for this conversation; `/skills <name>` activates one directly, `/skills list` shows every skill with its tier, what it shadows and why one cannot be used, `/skills new [what it should do]` starts the `skill-creator` interview, which ends on a screen where you choose to save the drafted `SKILL.md` to your user or project skills, or cancel, and `/skills save [name]` does the same for what this conversation just did, generalised and without secrets or tool output. After a multi-step task the TUI proposes `/skills save` in one dim line; `/skills save off` stops that in your user config and `/skills save on` restores it ([Learning from a task](skills.md#learning-from-a-task)). The model is offered skills on its own and loads one with the `skill` tool; see [Skills](skills.md). |
| `/plugins` | Inspect plugins, enable/disable them for the idle session, and optionally remember their state after restart. `/plugins list` lists them; `/plugins <name>` shows details. See [Plugins](plugins.md) for loading configuration and scope. |
| `/resume` | Resume a past conversation in this project. The list counts the messages you and the model wrote (tool traffic is not counted) and labels the preview "Last prompt:". `namzu resume` with no id opens the same list at launch. In a conversation whose last turn is paused or was interrupted, continue that turn under the same turn id, under the current permission mode (plan mode stays read-only). A scheduled run parked on a decision (`Scheduled: <job> · <time>`) shows the parked call on the permission screen: your answer applies to exactly that batch, and the rest of the work stays under the job’s rules. |
| `/abandon` | Close this conversation's paused or interrupted turn without resuming it, so the next prompt starts a new turn. The turn is recorded as failed with reason `abandoned`; nothing it already did is undone. |
| `/model` | Choose a model for the current provider, then its reasoning effort when supported. Other detected providers are named above the list; press `p` to switch providers. The picker states whether the model selection is saved for future launches. |
| `/login` | Sign in with a `Claude` or `Codex` subscription. |
| `/logout` | Remove a Namzu-owned subscription credential: `/logout [claude|codex|all]`. |
| `/cost` | Show tokens and cost for the latest reply, one fact per line, plus what the agents it started used; `/cost details` adds pricing and scope information. |
| `/jobs` | Open the session's shell job view to inspect output and stop a running job; `/jobs list` prints a text summary. |
| `/peers [list\|on\|off\|send <ref> <message>]` | Find and message independent live terminals in this project; control this terminal's participation. Peer text carries no operator authority. See [Messages between live terminals](peer-messaging.md). |
| `/release-notes` | Show what changed in the version that is running: /release-notes [version]. |
| `/hooks` | List the shell hooks this conversation runs, by event. |
| `/context` | Show how full the context is (`Context: 54k of 128k used (42%)`, "about" when it is an estimate) and whether older messages were summarised; `/context details` adds where the measurement comes from, thresholds and cleanup counters. |
| `/review` | Choose a review target, or provide custom instructions: /review [instructions]. |
| `/mcp` | Show connection state, tool counts and failures; `/mcp tools` lists tool names. `/mcp details` is equivalent. |
| `/diff` | Show what is uncommitted in this working tree, grouped per file with its line counts and the changed lines, drawn like an edit's result (line-number gutter, full-width green and red rows, changed words highlighted, three lines of context). |
| `/compact` | Summarise the older half of this conversation to free up context. `/compact <what to keep>` says what the summary must keep. |
| `/copy` | Choose the whole latest answer, a code block, or a quote to copy. |
| `/raw` | Toggle copy-friendly plain transcript rendering: /raw [on\|off]. |
| `/export` | Export this verified conversation to the clipboard or a Markdown file. |
| `/status` | Show model, permissions, workspace and latest cost, with the folder written from `~` or its last folders. The card leaves out the conversation id and the tool count; `/status details` adds the full conversation id, expands rules and isolation; `/status config` shows setting sources; `/status tools` lists callable tools. |
| `/permissions` | Choose Ask before changes, Auto-approve edits or Plan (read-only). More options contains Auto-approve tools, Preapproved tools only and View rules. |
| `/theme` | Change the colors: `/theme [name]`. Opens a picker with a live preview, or applies `auto`, `dark`, `light`, `dark-daltonized`, `light-daltonized`, `dark-ansi` or `light-ansi` directly. See [Themes](themes.md). |
| `/effort` | Choose reasoning effort for future replies: /effort [level\|default]. |
| `/hypermode` | Toggle hypermode for this conversation: /hypermode [on\|off]. An independent on/off, shown beside effort and never changing it: while on, the model is told to use the `workflow` tool for every substantial task. |
| `/orchestrate` | Deprecated alias of `/hypermode`, from before the mode was renamed. It prints a line saying so, then does what `/hypermode` does. It will be removed in a later major version. |
| `/init` | Write an AGENTS.md describing this project to future agents. |
| `/goal` | Open this conversation’s goal menu. `/goal status` reads progress; `/goal set` opens the objective editor. |
| `/schedule` | List [scheduled jobs](scheduled-tasks.md) and what needs you: a run waiting for approval, a job waiting for confirmation or on hold. `/schedule confirm|pause|resume|run|remove <job>` acts on one; `/schedule add <name> "<when>" <read-only|edit-in-folder> <prompt…>` creates one after showing it. |
| `/browser` | The [browser](browser.md) this session drives: engine, window or none, running or not, profile and site rules. `/browser profile <name>` switches profile for the rest of the session (closing the browser if it was open), and a rebuilt session keeps it. |
| `/loop` | Re-send a prompt to this conversation on an interval, between turns: `/loop 10m <prompt>`, `/loop list`, `/loop stop <id>|all`. See [Session loops](session-loops.md). |
| `/tasks` | Read this conversation's tasks: every open task, and those closed in the current turn. Changing conversations clears the previous selection. |
| `/agents` | Inspect delegated activity in this conversation; `/agents running` opens the same view. `/agents available` lists configured agents. `/agents batches` lists past and running batches of delegated agents. |
| `/workflows` | List this conversation's workflows, running and finished, and open one: its phases, then a phase's agents, then an agent's transcript. See [Workflows in the CLI](workflows.md). |

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

On exit, the CLI prints `namzu resume <id>`: the product command, never the
node binary or a build path, even when the app was started from a source
checkout or an alternate installation. A `cd` prefix is included only when
the conversation directory differs from the current working directory. Windows
prints `namzu.cmd` when npm's first matching command wrapper resolves to the
running CLI.
Its resume hint explicitly targets PowerShell, with a call operator
for the quoted executable. When a directory change is needed, it uses a literal
path and resumes only if that change succeeds, including in Windows PowerShell
5.1. Users exiting from Git Bash can run the labelled command in PowerShell.
See [Installing and reopening Namzu](installation.md) for shell-specific commands.

`/config` (also available as `/settings`) shows Model, Reasoning effort and
Permissions and Turn limits with their effective values, and opens the corresponding controls.
Turn limits defaults to unlimited tokens, model turns and duration. Enter a value
for any row; `0` or `unlimited` removes its cap. `/config limits` opens it directly,
and `/config limits unlimited` removes all three caps for future turns in this
TUI session. Running work keeps its captured limits and measured usage. See
[Turn limits](turn-limits.md) for direct commands and persistent configuration.
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
A mode name is not an alias for an effort level; available levels come from the
provider. See [OpenAI reasoning menus](../sdk/openai-reasoning.md) for Astra's
different API and subscription menus.

### Hypermode

`/hypermode` (`/hypermode on`, `/hypermode off`, or no argument to toggle)
turns a session setting on or off, layered above effort rather than inside it —
it is never a `ReasoningEffort` value, so `/effort hypermode` reports
`unavailable for this model`, the same refusal any other mode name gets, because
neither name is an effort level a provider publishes. When the `/effort`
picker can open (an exact menu, even an explicitly empty one, is known), the
mode also appears there as its own stop, visually apart from the levels.

For one message only, start or end that message with the word `hypermode`
(`hypermode fix the flaky test`): that turn is opted into the `workflow` tool
and the effort is left as it is, the next message is not, and the session
setting is not touched. See [Composer triggers](composer-triggers.md).

Hypermode never changes the reasoning effort, turning it on or off, with the
keyword or without. Choosing an effort
level never turns hypermode off either. `/hypermode on`
answers `Hypermode is on for this conversation: Namzu will use workflows for
substantial tasks. Effort stays high.` and `/hypermode off` answers
`Hypermode is off: workflows are offered only when you ask for one. Effort
stays high.` (`Effort stays at the model default.` when none was chosen; the
sentence is left out for a model that publishes no effort levels).
Choosing an effort level, in `/effort` or the picker, never touches the mode.

What the model is told. The `workflow` tool is in the tool list on every turn of
a terminal that can run one, with its opt-in rule in the tool text and a stable
note in the system prompt (the operator's keyword, hypermode on, the operator's
own words, a named saved workflow; anything else uses `Agent`).
While hypermode is on, a short hidden reminder (never the cached system prompt, never shown
as something you typed) says so: in full on the first message after it was
turned on, again sparsely after ten of your messages, and once when it ends;
the reminders are kept in the conversation, so a resumed conversation does not
hear the full text again. The end reminder reads (`Hypermode is off: the workflow tool's standard opt-in rule
applies again.`). A run that cannot start a workflow (a scheduled run) is told
to delegate substantial work to parallel agents with the `Agent` tool instead.

Start with it on: set `hypermode: true` in the user or project config
(see [Composer triggers](composer-triggers.md) for the config layers). The terminal starts every conversation
with the mode on (`/hypermode off` ends it for that conversation only), and
`namzu exec`, `exec --json` and scheduled runs tell the model it is on. No
environment variable sets it.

The mode was called orchestrate mode before; `/orchestrate` still works, prints
`/orchestrate is deprecated: the mode is now called hypermode. Use /hypermode;
/orchestrate will be removed in a later major version.`, and then does exactly
what `/hypermode` does. `/effort orchestrate` is refused as before.

On a terminal wide enough to hold every stop on one row (at least 60 columns,
and as wide as the labels need — about 70 for a four-level menu), the picker
is a left-to-right slider:

```text
  Faster                                                          Smarter
  ───▲────────────────────────────────────┆──────────────────────────────
  default   low   medium   high   xhigh   ┆ hypermode (workflows)
                                   Off · workflows on every substantial task
```

The stops are `default`, the model's published levels from low to high, and
then the hypermode stop after a `┆`, in violet. Beneath it, whole, its
one-line description with whether it is on: `Off · workflows on every
substantial task`. On a terminal where the description would run past the
right edge it moves left to end inside it. The `▲` marks the stop Enter
applies; the current setting's label is green. ←/→ move it and stop at the
ends; ↑/↓ do the same; a digit selects a stop directly; Home and End jump to
the ends; Enter applies; **Tab flips hypermode from any stop** and leaves the
effort alone; Esc goes back. On the highest level and on the hypermode stop a
line says they spend the most tokens and time; it wraps rather than being cut,
and its rows are kept blank on the other stops so the picker does not change
height as the caret moves. A narrower terminal, or a menu too long for one
row, gets the vertical list, with the same label and description as its own
row below a rule (Tab works there too). There is no separate key for "this
session only": the setting already lasts only for the session.

While the mode is on, the footer's effort item says so: `effort high ·
Hypermode on` (just `Hypermode on` when no effort was chosen), and the
composer's upper rule names `hypermode` as before. Like effort, the mode is
in-memory and per-session; it is not saved to preferences. A model switch
resets an explicit effort override to the new model's default as it always has;
hypermode stays on across it, and the interactive effort chooser that follows a
standalone `/model` pick opens whether or not the mode is on.

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
the main interactive agent, not headless turns or delegated agents.

`/effort` affects future turns in the current TUI session. `/permissions` and
Shift+Tab take effect at once, including while a turn runs: the running turn's
next approval decision is made under the new mode, and so is every later turn.
A decision already on screen keeps the mode it was asked under, entering `plan`
refuses the next change the turn attempts (a permission rule that allows it
included), and leaving `plan` approves nothing
it already refused. Each change is recorded as `approval_policy_changed` in the
session log before it takes effect.
The effort choices depend on the selected model and usable fallback models.
Explicit deny rules and built-in safety checks still apply in every mode;
`plan` additionally blocks writes even when a rule would allow them, except the one plan file ([Plan mode](plan-mode.md)).

The permission menu shows the current mode. More options keeps automatic approval
and preapproved-only execution available without placing their internal mode
names in the main menu. Esc returns from More options without applying a change.
The approval prompt has no answer that allows every tool. After Yes it can offer
one more answer, scoped to what was asked, and only when it holds for every call
in the prompt: for an edit, "Yes, and switch to accept edits for this session"
(the same change Shift+Tab makes, so the footer says `accept edits on`); for a
plain shell command, a fetch of one host or an MCP tool, "Yes, and don't ask
again for <that> this session". A remembered answer is consulted after your
`[permissions]` table and the safety gate, covers exactly the command line, host
or tool shown, and never covers a sandbox escape, a path outside the working
directory, a call a rule asks about, or a destructive one. It is kept in memory
for the session and is gone when it ends.
The menu lists every mode with a sentence each (Ask before changes, Auto-approve edits, Plan, Bypass permissions, Auto), and a mode this session cannot enter says why; only Preapproved tools only and the rules are under "More options". For typed shortcuts, `/permissions prompt`, `accept-edits`, `plan`, `bypass`, `auto` and `strict` are accepted ([Permission modes](permission-modes.md)); `bypass` is refused unless the launch opened it. `/permissions details` opens the rule report directly.

An explicit `ask` in the configured permissions table is retained as a review
rule, including when it precedes a broader wildcard `allow`. It also prevents
automatic read-only exemptions in prompt modes. Omitting a rule keeps the normal
read-only default. An `ask` rule is asked in every mode, `bypass` and `auto` included.

`/permissions details` also says, in `prompt`, `accept-edits` and `plan`, that
a read-only agent (`explore`, or an agent file with `readOnly: true`) on the
session's model starts without asking, and that a rule `Agent: "ask"` asks
about every launch. See [Delegated work](delegated-work.md#which-launches-are-asked-about).

## Goals and task scope

`/goal` opens actions appropriate to the saved goal. `/goal set` and
`/goal edit` open objective editors; `/goal set <objective>` and
`/goal edit <objective>` supply the text directly. `/goal status` only reads
the goal. `/goal pause`, `/goal resume` and `/goal clear` control automatic
continuation. Direct `/goal <objective>` input also remains supported.

Creating or resuming a goal enables automatic work. The menu and objective
editor show the automatic-turn allowance before submission. Pausing or
clearing prevents further automatic replies; it does not undo a running tool
call or interrupt the current turn. Goal reports distinguish the saved status
from whether automatic continuation is enabled or paused.

`/tasks` reads the session's durable task store, including updates made without
a visible task event. Before any turn has supplied a list, it reports that no
task list is available yet. A session with an empty store reports an empty list.
Switching conversations forgets the selected list without deleting stored
tasks. The command does not search other sessions. An embedded
session that does not expose task storage reports that listing is unavailable.

Usage and cost are also scoped to the current or latest turn, not the whole
conversation. Own model-call cost is separate from token totals that include
delegated agents. Unknown prices remain unknown, partly priced usage is a
lower bound, and measured zero is shown distinctly.

## Picker navigation

The model picker filters the current provider's catalogue by model ID, display
name and the note shown beside the row, as you type. Search ignores case and
matches every typed word, so `free` finds every row the picker marked `(free)`,
including the ones whose ID never spells the word.
Press `/` to start search explicitly, including a query beginning with `p` or
a number. Before search starts, `p` changes provider and numbers select a row;
while searching they are ordinary text. Left arrow always changes provider.
Backspace removes a character and Ctrl+U clears the search. A selected model
stays selected when it still matches, and current/default markers remain visible.
Arrows, PgUp/PgDn and Home/End move through the filtered results. Enter applies
the highlighted model; an empty result cannot be applied. Esc retains its
normal back or cancel behavior, including cancelling a pending selection.
The count in the model picker names the selected model and the total; arrows
beside it show when more models are above or below the visible rows. On wider
terminals, the arrows also show how many models are hidden in each direction.

A row is marked `(free)` when the price its listing carries is zero for both
input and output. Both, because a free prompt and a paid completion is not a
free model — the completion is where the tokens go. A price that is absent, or
that is not a finite number, is not a price of zero, so such a row stays
unmarked rather than being guessed at — see [Model prices](../sdk/model-prices.md).
The note repeats the provider's own answer about its own catalogue; namzu does
not re-price a model. The provider's order is preserved: the marker adds words
to a row and neither sorts nor hides any. Under 70 columns the notes are rebuilt
from a fixed vocabulary, and `(free)` joins `(default)` and `(image)` there
rather than being dropped.

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
- **Enter** during a turn steers a message into that turn at its next model boundary. **Tab** queues a message for a later turn. Both wait as `❯` rows above the composer's upper rule, with the message text and attachment count; a Tab-queued row says `after this reply`. **Ctrl+X Ctrl+S** sends them now (see the Esc line).
- **Up** on an empty composer chooses the newest queued message, **Up/Down** move, **Enter** loads it into the composer for editing and **Esc** leaves the choice. **Alt+Up** recalls the latest operator-composed queued message for editing, with its attachments and armed triggers. A queued slash command returns as the command the operator typed; its expanded model prompt remains queued until recalled. It leaves a nonempty draft alone; automatic goal and skill prompts cannot be recalled this way.
- **Esc** while a turn runs interrupts it. An undelivered steer starts a fresh turn before Tab-queued messages after the old turn settles. Without a pending steer, queued messages remain held; a new Enter message runs before them, while Tab adds to the held queue. **Ctrl+X Ctrl+S** does the same as Esc with a pending steer and also releases queued messages Esc had held. **Ctrl+C** is reserved for exit.
- **Left** on an empty composer (nothing typed, pasted or attached) opens the agents cockpit, as `/agent` does; the footer's `← N agents` names it. **Down** on an empty composer focuses the footer: the shell pill first (Enter opens the `/jobs` screen), then the agents rail; the footer's `↓ to manage` names it. With anything in the composer both keys move the cursor.
- **Shift+Tab** cycles the permission mode: `prompt`, `accept-edits`, `plan`, then `bypass` when the launch opened it (`--yolo`, `--allow-dangerously-skip-permissions`, `permissions.defaultMode: bypass`; see [Launch flags](launch-flags.md)), then `auto` unless `permissions.disableAutoMode` is set, then `prompt`. `strict` is not on the cycle and goes back to `prompt`; see [Permission modes](permission-modes.md). It works mid-turn, and the footer is its only reply: nothing is added to the transcript. Plan mode has its own way out: the model presents its plan and you approve it, which switches the mode to the one you choose ([Plan mode](plan-mode.md)).
- **Ctrl+O** expands small tool output in place. Older or oversized output opens a bounded viewer without appending transcript copies; with the live output already open, the next press opens the newest output that has settled into history. Use ↑↓ or PgUp/PgDn to scroll, ←→ to switch retained outputs, g/G for the beginning/end, and Esc, q or Ctrl+O to close.
- **Ctrl+T** opens or closes delegated activity, also reachable with `/agents`.
- **`!command`** runs on the host without the model; **`#note`** remembers. See [The composer prefixes](composer-prefixes.md).
- **Alt+W** drops the [composer trigger](composer-triggers.md) nearest the cursor (`hypermode`, "bunu skill olarak kaydet"), restores a dropped one, or arms one the row only suggests. **Backspace** right after an armed `hypermode` drops it before it deletes anything.

### Resuming a conversation

`/resume` shows a conversation under the name a person gave it with `/rename`;
failing that, under a two-to-five-word title the
[small model](small-model.md#conversation-titles) wrote after the conversation's
first message; failing that, under the first authored prompt (not project
instructions). Old derived `Conversation` placeholders are replaced in the list
when the original prompt is still available; deliberately chosen names are
preserved and are never replaced by a generated title. On terminals at least 20 rows high, the selected row shows
the last authored prompt, saved message count and full conversation UUID. Short
terminals retain the compact list so navigation remains visible.

Opening saved history restores nonempty public assistant text in its original
item order, including retained commentary and final-answer parts. Tool-only or
private-reasoning-only messages do not create empty assistant rows. This is a
text projection: it does not reconstruct historical tool cards or remove tool
calls, results or provider replay state from the next model request. If stored
parts no longer agree with the current selected content, only that content is
shown, so edited or compacted text is not replaced by stale parts.

When an active or paused goal is present after opening a saved conversation,
Namzu offers **Resume goal** or **Not now**. Opening history alone does not arm
automatic work. Choosing Resume uses the existing `/goal resume` path and its
budget checks; dismissing the picker leaves automatic work stopped. Completed
or blocked goals are not automatically offered for continuation.

Provider setup is also reachable with `s` in the provider picker. Namzu does not
require an external CLI for its own Codex/Claude sign-in or anonymous Zen models.
The setup screen probes `--version` with bounded subprocesses and displays only
credential source kinds, never credentials. When no Claude credential is found,
it says "Not signed in for Namzu" (Claude Desktop's sign-in does not always give
Namzu a reusable session) and points to `namzu login claude`. `i` proposes the exact npm global
install command for a missing CLI; only `y` on that confirmation runs it.
Installation can execute third-party package scripts. Escape cancels the owned
installer process group; files already installed may remain. After it finishes,
Namzu checks the executable again. `c` opens connection/model selection with
fresh credential discovery. Installation success does not establish sign-in or
account quota. On POSIX systems npm must already be available on PATH. On native
Windows, installation runs npm's JavaScript entry point bundled beside the Node
runtime running Namzu, without a command shell. Custom PATH wrappers are not
used; a missing npm bundle is reported with a repair instruction. Escape requests
termination of the Windows installer process tree; a failure to confirm cleanup
is reported. Installation failures remain visible.

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
