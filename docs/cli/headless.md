---
title: Headless runs
description: namzu run and namzu run-stream — one prompt, no terminal. Shared options, the working directory, exit codes, and the NDJSON event stream.
last_updated: 2026-08-05
status: current
related_packages: ["@namzu/cli"]
---

# Headless runs

Two commands run a single prompt without a terminal. They are the same one-shot
and differ only in how they report:

| Command | Output | Written for |
| --- | --- | --- |
| `namzu run` | The reply on stdout, status lines on stderr | Shells, scripts, CI |
| `namzu run-stream` | One JSON event per line on stdout, as the turn unfolds | A host UI rendering progress |

```bash
namzu run "fix the failing test"
echo "summarise this" | namzu run
cat notes.txt | namzu run "summarise this"
namzu run-stream --session ses_42 "what changed?"
```

### Piped input

`namzu run` uses a pipe and a prompt argument together, rather than choosing
between them:

| Invocation | Prompt the model receives |
| --- | --- |
| `namzu run "question"` | the argument |
| `echo "question" \| namzu run` | the piped text |
| `cat file \| namzu run "question"` | the argument, then the file fenced in a `<stdin>` block |
| `namzu run -` | the piped text (explicit stdin sentinel) |

Fencing is what lets the model tell the request from the material it is about;
without a boundary the last line of a long paste runs into the question.

When the prompt came from an argument, namzu waits up to 250ms for the first
byte of piped input and then proceeds without it — otherwise `namzu run "hello"`
would wait forever in any context where stdin is open and silent, such as a CI
step. Once input starts arriving it is read to the end with no deadline, so a
large or slow producer is never truncated. With no prompt argument the wait is
unbounded, because the caller has said the prompt is coming.

`run-stream` reads stdin differently on purpose: without `--session` it expects a
JSON `Message[]` of prior conversation there, not prompt text. That is the one
input channel the two commands do not share, because it means two different
things to their two different callers.

Both need a provider. Set a credential in the environment, or run `namzu` once
and pick one — see [Providers & credentials](./providers.md).

## Options

Both commands take the same options, parsed by the same code. Everything that is
not an option is the prompt.

| Option | Effect |
| --- | --- |
| `--cwd <path>` | The directory the agent works in. Defaults to the current one. |
| `--provider <id>` | Answer with this provider instead of the stored preference. |
| `--model <id>` | Answer with this model instead of the stored preference. |
| `--skills <a,b,c>` | Load these skills as context for the turn. See [Skills](./skills.md). |
| `--session <key>` | Bind the turn to a persisted conversation (see below). |
| `--` | End of options. Everything after it is prompt text, verbatim. |

An option that is not on this list is refused. It is not passed to the model:

```console
$ namzu run --temperature 0.5 "hello"
Error: unknown option(s): --temperature — pass `--` before a prompt that starts with a dash
$ echo $?
64
```

Use `--` when the prompt itself starts with a dash:

```bash
namzu run -- --force means what in this codebase?
```

### Tool approval

A headless turn never prompts for approval — there is nobody to ask — so tools
run without asking. The safety gate that refuses catastrophic shell commands
still applies and cannot be turned off. `--yolo` and
`--dangerously-skip-permissions` are accepted for symmetry with the interactive
launch and do nothing here, because there is no prompt to skip. See
[Tools & permission](./tools.md).

## The working directory

`--cwd` is the directory the whole run is built on: what `glob`, `read`, `edit`
and `bash` resolve a relative path against, where sub-agents run, where project
skills are discovered, and where the `.namzu` session and task stores live.

```bash
namzu run --cwd ../other-checkout "which tests are failing?"
```

A relative path resolves against the current directory. A path that does not
exist, or is not a directory, is refused before the run starts — namzu will not
quietly fall back to the current directory, because a run that searches the
wrong tree reports that your files are missing rather than that it looked in the
wrong place.

## Sessions and history

Without `--session`, a run is stateless: nothing is persisted, and it does not
appear in `/resume`. `run-stream` will read prior history from stdin as a JSON
`Message[]` if you pipe it.

With `--session <key>`, the turn is bound to a persisted conversation in the
working directory's `.namzu` store, keyed by an id you choose. Prior turns are
loaded as context and the new pair is appended, so a host can reopen a
conversation later:

```bash
namzu history --session <key> [--cwd <path>]
```

`history` prints the conversation's user and assistant messages as a JSON array.
An empty array means the session exists and has no messages — it is not an
error.

## Exit codes

`namzu run` is written for `$?`:

| Code | Meaning |
| --- | --- |
| `0` | The model answered and the run finished normally. |
| `1` | The run failed, or stopped early — a token budget, a timeout, the iteration cap, a cancellation, or a refused answer. Any partial output is still printed, and the reason goes to stderr. |
| `2` | No prompt was supplied. |
| `64` | An argument is wrong (unknown option, bad `--cwd`). |

A stopped run exits 1 even though it produced text, so
`namzu run … > out.txt && deploy` cannot proceed on a partial or refused answer.

`namzu run-stream` answers a host that is line-scanning stdout, not a shell, so
it reports the same conditions **in band** and exits 0. Every run ends with a
terminal event, including a refusal:

```json
{"kind":"error","message":"--cwd does not exist: /projects/typo"}
{"kind":"done"}
```

## The event stream

`run-stream` writes one JSON object per line. Status logging is silenced, so
every line on stdout is a valid event.

| `kind` | Carries |
| --- | --- |
| `delta` | `text` — a fragment of the reply |
| `tool-start` | `toolUseId`, `toolName`, `summary`, optional `detail` lines |
| `tool-end` | `toolUseId`, `toolName`, `isError`, `summary`, optional `detail` lines |
| `usage` | `totalTokens`, `costUsd` |
| `task` | `subject`, `status` — the agent's own plan items |
| `error` | `message` |
| `done` | optional `stopReason` |

Two read-only helpers exist for a host building pickers, both taking `--cwd` and
both printing `[]` rather than failing:

```bash
namzu skills-json --cwd <path>     # [{name, description, source}]
namzu providers-json               # [{provider, label, detected, default, models}]
```

## Permission modes

The `[permissions]` table says what a tool may do. `--permission-mode` says what
happens to everything it did not cover.

| Mode | An undecided call is | Default when |
| --- | --- | --- |
| `prompt` | asked about | a terminal is attached |
| `auto` | approved | there is no terminal — every headless run, historically |
| `strict` | refused | never; you ask for it |

```bash
namzu run --permission-mode strict "run the test suite"
```

`strict` is the mode for an unattended run: nothing executes unless a rule
allowed it by name or pattern, and the model is told that asking again will not
help. Before it existed an unattended run could only be `auto`, so a CI job
either trusted the agent with everything or could not use it at all.

`--yolo` and `--dangerously-skip-permissions` mean `--permission-mode auto`.

### Precedence between the flag and the file

**A mode only governs calls no rule decided, so it can never reopen what a rule
closed.** A rule that denied a call already stopped it and a rule that allowed
one never asked, so neither reaches the mode. `--permission-mode auto` cannot
run something the config says `deny`, and neither can `--yolo`. The
dangerous-pattern floor sits above both.

The direction is deliberate. The config file is written once, read by whoever
reviews the repository, and changed on purpose; a flag is typed in a hurry by
someone who wants to get on with it. A prohibition a flag can lift is not a
prohibition.
