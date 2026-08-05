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

Both commands are parsed by the same code, so an option spelled one way for one
is spelled the same way for the other. Everything that is not an option is the
prompt.

| Option | Effect |
| --- | --- |
| `--cwd <path>` | The directory the agent works in. Defaults to the current one. |
| `--provider <id>` | Answer with this provider instead of the stored preference. |
| `--model <id>` | Answer with this model instead of the stored preference. |
| `--skills <a,b,c>` | Load these skills as context for the turn. See [Skills](./skills.md). |
| `--session <key>` | Bind the turn to a persisted conversation (see below). |
| `--permission-mode <m>` | `prompt`, `auto` or `strict` — what happens to a call no rule decided. See [Permission modes](#permission-modes). |
| `--yolo` / `--dangerously-skip-permissions` | `--permission-mode auto`. |
| `--continue` (`-c`) | Reopen the most recent conversation here. `namzu run` only. |
| `--resume <id>` | Reopen the conversation you name. `namzu run` only. |
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

A headless turn has nobody to ask, so `prompt` is not a mode it can end up in:
with no flag, the mode resolves to `auto` and every call runs, which is what a
headless run has always done. [`--permission-mode`](#permission-modes) is how
you change that.

The safety gate that refuses catastrophic shell commands sits above every mode
and cannot be turned off by any flag. See [Tools & permission](./tools.md).

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
| `context` | `text`, `shed` — a compaction pass ran (see below) |
| `task` | `subject`, `status` — the agent's own plan items |
| `error` | `message` |
| `done` | optional `stopReason` |

### `context`, and why it is on the stream at all

A long turn compacts: the runtime discards old history to keep the conversation
inside the model's window. That deletion is irreversible, and until it was
reported the first a user knew of it was the agent having forgotten something
they were relying on — which reads as the model being stupid rather than as the
harness dropping context.

`shed` distinguishes the two outcomes. `true` means history was discarded and
`text` says which counts became which. `false` means a pass ran and declined, so
**the history is unchanged** — worth surfacing rather than swallowing, because a
run that could not shed carries on at full context toward a provider rejection
several turns later that will name none of this. `text` says which of the three
declines it was.

Render both. A host that shows only `shed: true` reproduces the original silence
on exactly the runs that are in trouble.

Two read-only helpers exist for a host building pickers, both taking `--cwd` and
both printing `[]` rather than failing:

```bash
namzu skills-json --cwd <path>     # [{name, description, source}]
namzu providers-json               # [{provider, label, detected, default, models}]
```

## Permission modes

Every tool call is first put to a verification gate, which answers `allow`,
`deny` or **`review`**. `--permission-mode` says what happens to the calls that
came back `review` — the ones nothing decided either way.

| Mode | An undecided call is | Default when |
| --- | --- | --- |
| `prompt` | asked about | a terminal is attached |
| `auto` | approved | there is no terminal — every headless run, historically |
| `strict` | refused | never; you ask for it |

```bash
namzu run --permission-mode strict "run the test suite"
```

`strict` is the mode for an unattended run. Read-only tools still run — `read`,
`glob`, `grep`, and the memory and task tools observe without changing anything,
so the gate allows them outright and they never reach the mode. Everything else
is refused, and the model is told in the refusal that asking again will not
help, so it stops rather than rewording the same call.

Before `strict` existed an unattended run could only be `auto`, so a CI job
either trusted the agent with every tool it might reach for or could not use it
at all. `strict` makes a headless run something you can reason about: it can
look, and it cannot touch.

`--yolo` and `--dangerously-skip-permissions` mean `--permission-mode auto`.
They were previously accepted and documented as doing nothing, which was true
and unsatisfying.

### What a mode cannot do

**A mode only governs calls the gate sent to review, so it can never reopen what
the gate closed.** A denied call was already stopped and an allowed one never
asked, so neither reaches the mode at all. `--permission-mode auto` cannot run
something the gate denies, and neither can `--yolo`; the dangerous-pattern floor
sits above both and no flag reaches it.

The direction is deliberate. A gate rule is a durable statement someone
reviewed; a flag is typed in a hurry by someone who wants to get on with it. A
prohibition a flag can lift is not a prohibition.

Which rules the gate holds is set by the host that builds the session. For the
rule vocabulary and how to supply it, see
[Tool Safety](../sdk/tools/safety.md) — `namzu` itself currently runs the gate
with its two standing policies (deny catastrophic shell patterns, allow
read-only tools) and no additional rules, so in practice the mode is the whole
of the operator-facing control here.

## Resuming a conversation

```bash
namzu run --continue "and now the integration tests"
namzu run --resume ses_abc123 "what did we decide about the cache?"
```

`--continue` (short form `-c`) takes the most recent conversation in the working
directory; `--resume <id>` takes the one you name and no other. `namzu history`
lists what is there.

**Both are `namzu run` only.** `run-stream` gets its prior turns from `--session`
or from a JSON `Message[]` on stdin; that is the channel a host UI already has,
and it is the one to use there.

**Both refuse when the conversation cannot be reopened, and say why. Neither
ever falls back to starting a new one.**

That is deliberate, and it is the important part. Someone who types `--resume`
is asking for *that* conversation. Silently starting a fresh one hands back
something indistinguishable from what they asked for, and they discover it
several turns later having already acted on an agent that has no idea what they
are referring to. Resuming with a partial transcript is worse still: a
half-context is not a degraded context, it is a different context that lies
about being complete.

The refusal names the cause, because the causes have different fixes — "no
previous conversation in /path" points at `--cwd`, which is usually the real
mistake, while a bad id lists how many other conversations are there.

There is no way to spell "resume if you can, otherwise start". Run the command
with no flag if that is what you want.
