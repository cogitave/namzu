---
type: Reference
title: Launch flags for the interactive session
description: --system-prompt, --tools, --name, --bare, --debug-file, --settings, --mcp-config, --provider, --model, --effort, --fast, --permission-mode, the first message, --continue, --resume and --from-pr on the interactive namzu and namzu resume, what each chooses for that launch only, how they combine with the saved choice and --yolo, the switch that lets Shift+Tab reach bypass, and what happens when one cannot be honoured.
resource: packages/cli/src/tui/launch-settings.ts
tags: [cli, tui, providers, permissions]
status: stable
generated: { by: human:bahadirarda, at: 2026-10-08T00:00:00Z }
---

# Launch flags for the interactive session

The [process-local model profile](model-profiles.md) also accepts model choices
through environment variables. Explicit `--provider`, `--model` and `--effort`
flags win over those defaults. `--max-output-tokens <n>` sets the per-call output
allowance for an interactive launch, including `namzu resume`, without editing
config or preferences; pass it after `exec` for headless work. The reminder to check edits before a turn ends is off unless `limits.doneGate` is `true` in the config; `--no-done-gate` turns it off again for one launch ([Turn limits](turn-limits.md#done-gate)), and `namzu exec` reads `limits.doneGate` from the config instead.

```sh
namzu --provider openai --model gpt-5 --effort high --permission-mode plan
namzu --model gpt-5                # re-model the saved primary for this launch
namzu --permission-mode accept-edits resume <conversation-id>
```

`namzu resume` takes the conversation id printed when Namzu last exited; with no id it opens the list of this folder's conversations, the same list `--resume` with no value opens.

Five options choose how one interactive session starts. They are written before the command name, or after `namzu resume` (the one command that takes them in both places), and they are **session-only**: nothing is written to `preferences.json`, so the next plain `namzu` starts on whatever you last picked in the app. Inside the session `/model`, `/effort` and `/permissions` work as they always do and replace the launch choice.

| Flag | Chooses | Values |
| --- | --- | --- |
| `--provider <id>` | the provider for this launch | an id from the provider list |
| `--account <name>` | the account for this launch | a name from `/auth`, or `provider:name` ([Accounts](accounts.md)) |
| `--model <id>` | the model for this launch | a model id the provider offers |
| `--effort <level>` | the reasoning effort | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `--fast` | fast inference, on for the first session | none; Anthropic and OpenAI models that offer it (`/fast` explains), billed at a multiple of the standard rate or using more of a Codex subscription's allowance |
| `--permission-mode <mode>` | the permission mode | `prompt`, `accept-edits`, `plan`, `bypass`, `auto`, `strict` ([Permission modes](permission-modes.md)) |

Two switches change what Shift+Tab may reach rather than where the session starts. `--dangerously-skip-permissions` (alias `--yolo`) starts in `bypass`, and `--allow-dangerously-skip-permissions` keeps the launch mode but lets Shift+Tab and `/permissions` reach `bypass`; the cycle is `prompt`, `accept-edits`, `plan`, then `bypass` (only when the launch allowed it), then `auto` (unless `permissions.disableAutoMode` is set), then `prompt`. `--permission-mode bypass` counts as launching in `bypass`. `--permission-mode auto` is the classifier mode, not the old no-prompt one. A launch the settings or the root guard forbid (`permissions.disableBypassMode`, bypass as the superuser outside a sandbox) is refused with exit status 64 and a plain sentence. The first time a launch starts in `bypass` it asks `Start in bypass mode? [y/N]` once; a no starts in the ordinary mode. `--allow-dangerously-skip-permissions` is for the interactive session only; `namzu exec` does not take it.

The first message of a launch is written as a plain argument: `namzu "fix the failing test"`. The session sends it once, as a plain prompt (a leading `/`, `!` or `#` is text, not a command), as soon as the composer is ready, and the turn runs with the provider, model, effort and mode chosen above. It is shown as the first user message, is kept in the composer's history, and is never sent again by a later `/resume`, reload or re-login. A word that is the name of a command runs that command, so put a prompt that is one such word after `--`: `namzu -- "providers"`. `--` is also how a prompt that begins with a dash is written: `namzu -- "--rm is a flag, explain it"`. Write it as one argument, in quotes; two words that are not one argument are refused (`Too many arguments`). A retired command name typed as the prompt prints what replaced it. The first message is refused before a subcommand like the other launch options, and before `resume` (exit 64): a resumed conversation never gets a first message. To answer one prompt without opening the session, use `namzu -p` ([Print mode](print-mode.md)).

`--message=<text>` is the older spelling, hidden from `--help`: builds already installed pass it, so it keeps working and gives the same result. Use `namzu "<text>"` in anything new.

Four more options are per-run settings rather than a choice of provider, model or mode: `--append-system-prompt <text|@file>`, `--allowed-tools <list>`, `--disallowed-tools <list>` and `--fallback-model <provider/model[,…]>`. They are session-only too, are written before the command, and are described in [Flags for one run](run-flags.md). `--max-budget-usd` is not one of them: a spend limit belongs to a headless run, so without `-p` it is refused with `--max-budget-usd needs -p` ([Print mode](print-mode.md)).

The same four flags exist on `namzu exec` and `namzu drain`, written after the command, where they apply to that run. Written before `exec`, `drain` or any other subcommand they are refused with exit status 64 and a line naming where they go, so a flag is never silently ignored.

## Shaping one launch

These options change what one launch starts with. All are session-only: nothing is written to a settings file. Written before the command or after `namzu resume`; for headless work they go after `exec`, or anywhere after `-p` ([Print mode](print-mode.md)).

| Flag | What it does |
| --- | --- |
| `--system-prompt <text\|@file>` | replaces Namzu's own system prompt text |
| `--tools <list>` | offers the model only these tools |
| `-n`, `--name <name>` | names the conversation |
| `--bare` | minimal start, see below |
| `--debug-file <path>` | writes every log record to a file |
| `--settings <file-or-json>` | adds one settings layer |
| `--mcp-config <file-or-json>`, `--strict-mcp-config` | adds tool servers, or uses only those |

### `--system-prompt`

`--system-prompt "<text>"` or `--system-prompt @rules.md` (a file, relative to the folder you ran the command from; up to 100,000 characters) puts your text where Namzu's own system prompt text would be.

**Replaced:** Namzu's identity and working rules, the sections that teach tools (memory, questions, files, delegation, browser), the reply style and commit-text notes, and the environment block (folder, date, git facts).

**Not replaced:** the tools themselves and their descriptions, `--append-system-prompt` (it still goes after your text), project instruction files (`AGENTS.md`), saved memory notes, the notes a turn adds about itself (the permission mode, a hook's message), and skills. A launch with `--system-prompt` and `--bare` is the plainest start Namzu has. An empty value, an unreadable file or a folder is refused with exit status 64 before anything opens.

### `--tools`

`--tools "read edit bash"` offers the model only those tools; names are the ones `--allowed-tools` takes (comma or space separated, built-in names in lower case, a tool server's tools by their exact `mcp__server__tool` name). `--tools ""` offers none, and `--tools default` offers all (the same as leaving the flag out).

This **removes tools**, it is not a permission rule: a tool that is not listed is not in any request, and its guidance is left out of the prompt (leave out `agent` and the delegation advice goes with it). Permission rules (`--allowed-tools`, `--disallowed-tools`, `permissions`) still decide the calls of the tools that remain. An entry with a pattern such as `bash(git status*)` is refused here with exit status 64; patterns go in `--allowed-tools`. A name no tool has is not an error: it matches nothing.

### `--name`

`-n "billing fix"` or `--name "billing fix"` names the conversation as `/rename` does, so the resume picker, `namzu --resume "billing fix"` and the terminal title carry it. The conversation is created at once rather than at the first message. With `-c`, `-r` or `namzu resume <id>` it renames the conversation you open. In `namzu exec` and `-p` it names the conversation the run is kept in.

### `--bare`

A minimal start for a run that should depend on nothing but the prompt and the tools. It turns off:

| What | How |
| --- | --- |
| hooks | `disableHooks` for this launch (every hook from your files and the project's; managed hooks follow the managed file's own rule) |
| plugins | `plugins.enabled: false` (a folder named with `--plugin-dir` still loads: naming it is consent) |
| project instruction files | no `AGENTS.md`, rules or personal instruction file is read or offered, including for delegated agents |
| saved memory notes | the curated memory files are not put in the prompt and automatic recall is off (`memory.recall: false`) |
| learning | no observations are recorded and the background learning generator is off |
| code index | the `code_analysis` tool is not mounted and its index is never built |
| skill proposals | the one-line offer to save a turn as a skill is off |
| background catalogue refresh | `modelCatalogueRefresh: false`: no network read for the model list; the bundled one is used |
| update check | `updates.check` and `updates.auto` off: no background look for a newer Namzu |

Skills you name yourself (`/skills`, `--skills`) and the built-in skills still work. Namzu has no language-server integration, so there is nothing of that kind to turn off. `--bare` is a settings layer, so `--settings` can switch one of these back on.

### `--debug-file`

`--debug-file /tmp/namzu/debug.log` appends every log record, debug level included, to that file as one JSON object per line, from the start of the process. What appears on screen keeps its usual level (`-v` and `-q` still decide that). Only the folders of the path you give are created; a path that cannot be opened is refused with exit status 64. It works for every command and for the terminal session, which writes nothing to stderr while it runs.

### `--settings`

`--settings team.json` or `--settings '{"effort": "high"}'` adds one settings layer from a JSON file or an inline JSON object, with the keys of the [configuration](config-command.md). Its place in the order is above your user file, the project files, a profile and the environment, below the command-line flags that name the same thing (`--effort`, `--permission-mode`, ...) and below the organisation-managed file, which always wins. A key Namzu does not know, a value of the wrong kind, text that is not JSON, or a file that cannot be read is one sentence on stderr and exit status 64. The layer is not saved and counts as your own word: a repository cannot supply it.

### `--mcp-config` and `--strict-mcp-config`

`--mcp-config <file-or-json>` adds the tool servers of a file (the shape of `.mcp.json`) or of inline JSON starting with `{`, for this launch; repeat it for more. A later one wins over an earlier one and over the config for a server of the same name; a missing file or invalid JSON is refused with exit status 64 before anything opens. Write one value per use (`--mcp-config a.json --mcp-config b.json`), so a first message after it is not read as a file. `--strict-mcp-config` uses only the servers named by `--mcp-config`: the configured servers and the project's `.mcp.json` start nothing; with no `--mcp-config` it starts no tool servers at all. A server given with `--mcp-config` needs no approval, because you chose it ([Tool servers](mcp-servers.md)).

## After `resume`

`namzu resume <conversation-id>` is the command Namzu prints when it exits, so every launch option above is accepted after it as well as before it, with the same meaning: `--provider`, `--account`, `--model`, `--max-output-tokens`, `--no-done-gate`, `--effort`, `--permission-mode`, `--dangerously-skip-permissions` / `--yolo`, `--allow-dangerously-skip-permissions`, `--append-system-prompt`, `--allowed-tools`, `--disallowed-tools`, `--fallback-model`, `--system-prompt`, `--tools`, `--name`, `--bare`, `--debug-file`, `--settings`, `--mcp-config`, `--strict-mcp-config`, `--add-dir`, `--plugin-dir`, `--profile` and `--output-schema`. They go through the same checks as before the command, including the one-time `Start in bypass mode? [y/N]` question, and a permission flag given at resume time wins over the mode the conversation was last in, exactly as it does for `namzu --resume <id> --yolo`.

```sh
namzu resume --yolo 11de68ce-02f2-49e4-a7e4-7f29355d7aaf
namzu resume --permission-mode plan --model gpt-5
```

A flag given on both sides is not an error: the value after `resume` wins, and a repeatable one (`--add-dir`, `--plugin-dir`, `--allowed-tools`, …) keeps the values from both. `--continue`, `--resume`, `--from-pr` and the first message choose or start a conversation, so they stay before the command, where they are refused beside `resume`. The global output flags (`--format`, `--quiet`, `--verbose`, `--debug`, `--log-format`) are not launch options and also stay before the command.

## Picking up a conversation: `-c` and `-r`

```sh
namzu -c                      # the most recent conversation in this folder
namzu --resume                # the /resume picker
namzu --resume "billing fix"  # the conversation with exactly that title
namzu -r 11de68ce-02f2-49e4-a7e4-7f29355d7aaf
```

These apply to the interactive session only (the same flags on `namzu exec` are separate and refuse rather than open a picker). `-c` / `--continue` opens the most recent conversation in this folder, and says so and exits 64 when there is none. `-r` / `--resume` with no value opens the `/resume` picker as soon as the composer is ready. With a value shaped like a conversation id it resumes that conversation or refuses with the cause; with any other value it resumes the one conversation whose title is exactly that, and otherwise opens the picker with the value as a search (case-insensitive, over the title and the opening message), or says nothing matched. Passing both is refused, and so is either flag before a subcommand or before `resume`. `--from-pr [value]` opens the same picker with only the conversations linked to a pull request, or to the one the number or address names ([GitHub workflows and pull request links](github.md#finding-the-conversations-of-a-pull-request)); it is refused beside `--continue` or `--resume`, and before a subcommand. `--resume` takes the next word as its value, so write `namzu -c resume <id>` rather than `namzu --resume resume`; a value that begins with a dash needs `--resume=<value>`.

## How they combine with what is saved

- **`--provider`** replaces the provider chain with that provider alone, so a fallback you saved cannot answer in its place. With `--model` it names that provider's model; without it the provider chooses its own default.
- **`--model` alone** re-models the saved primary provider and keeps the saved fallbacks behind it. With nothing saved there is no provider to apply it to: the provider list opens and says so.
- **`--permission-mode`** names the starting mode outright and wins over `--yolo` / `--dangerously-skip-permissions`, which in turn win over `permissions.defaultMode`. With none of them the interactive terminal starts in `auto` when its classifier can reach a model, and in `prompt` when it cannot ([Auto is the terminal's default](permission-modes.md#auto-is-the-terminals-default)). The status report (`/permissions`, `/status`) says the mode was selected at launch, by the configuration, or by that default.
- **`--fast`** applies to the first session the launch opens and is never saved. On a model without fast mode it is reported (`--fast was not applied: <reason> Continuing at standard speed.`) and the session runs normally. The same applies on a custom or compatible `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL`. When it is applied, one line says what it costs (`Fast mode on: faster replies, billed at twice the standard rate.`). `--fast` is a flag with no value and means the fast tier; the faster `ultrafast` tier is asked for inside the conversation with `/ultrafast`. `/fast` toggles it from inside; a `/model` pick made while a reply runs that cannot keep it waits for the reply to end, and a `--fallback-model` without fast mode fails the turn it serves with `fast_mode_unsupported`; the footer shows `fast` (or `ultrafast`) while it is on.
- **Saved `fast` and `effort`** (`fast: true`, `effort: high` in the user or managed config file; Desktop Settings > Models) are the saved forms of the two flags and sit below them. `--effort` and `NAMZU_EFFORT_LEVEL` win over a saved `effort`, a level picked inside the conversation wins over all three, and a saved level the model does not offer is ignored without a message, so the model's own default stands. A saved `fast` starts the first session in fast mode like `--fast`, on the same models (it now also takes effect on the OpenAI models that offer fast mode, where it costs more or uses more of a subscription's allowance), says what it costs when it is applied, and when the model cannot take it the session runs at standard speed and says `The saved fast mode setting was not applied: <reason> Continuing at standard speed.` Fast mode is read by the terminal app only. A saved `effort` also applies to Desktop conversations, from the next one started. A project's `namzu.config.json` cannot set either: a repository must not decide what a conversation costs. Default effort is the model's own, and fast mode is off, because it bills at a multiple of the standard rate. The `fast` setting is `true` or `false` only: `ultrafast` is never saved.
- **`--effort`** applies to the first session the launch opens. A level the chosen model does not offer is reported (`--effort high is not offered by <model>; using the provider default.`) and the default stays; the levels a model offers are the ones `/effort` lists.

## When a launch cannot be honoured

An unknown provider, or one the session cannot start on, does not leave an unusable session: the provider list opens with the reason in plain words (`nopeai is not a provider Namzu knows. Choose one from the list below.`, or `Couldn’t start with <Provider> and <model>.`), and picking from it is an ordinary choice. A `--model` the provider has never heard of starts the session like any other: the id is sent as given (without its `[1m]` window marker), and if the provider answers that it has no such model, the reply says so in plain words and points to `/model`. Nothing is checked against a model list at launch, because a list can be incomplete or name models differently from the endpoint that serves them. An invalid `--effort` or `--permission-mode` value is refused before anything starts, with the values it takes and a pointer to `namzu --help`.

`--debug` (or `NAMZU_DEBUG=1`) shows the technical text that the terminal app otherwise keeps out of sight: the provider's structured error under a failed reply, the cause behind a failure the app could not explain, and the stack of a crash.

## Environment markers

The terminal app draws live in a terminal even when the shell exports `CI` or a similar marker; only its own drawing is affected, and the commands the agent runs still see the same variables. With output or input piped, the usual detection applies.

## The desktop's terminal tabs

The Desktop's "CLI" surface for the Namzu engine starts this same command in a terminal tab with the composer's choices as these flags, and the composer's text as the one argument after `--`, which is why they are session-only: the person's saved preferences are theirs, and a tab started for one task must not rewrite them. See [Desktop](desktop.md#host-terminals).
