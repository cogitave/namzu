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
namzu run-stream --session ses_42 "what changed?"
```

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
