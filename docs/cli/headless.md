---
title: Headless runs
description: namzu run and namzu run-stream — one prompt, no terminal. Shared options, the working directory, exit codes, and the NDJSON event stream.
last_updated: 2026-08-09
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

Both load the working directory's
[project instructions](./project-instructions.md) — including the ones a
`--cwd` points at, not the ones where you happen to be standing. `run` names the
files it loaded on stderr, below the provider line; `run-stream` loads them
identically but does not yet announce them on its event stream.

## The folder has to be trusted

namzu reads a folder's files, runs commands in it, and executes its code — and
a headless run approves those tools without asking, because there is nobody to
ask. So a folder nobody has trusted is refused, before a session is built and
before anything in it is read.

```console
$ git clone https://example.invalid/someones-repo && cd someones-repo
$ namzu run "what does this do?"
Error: refusing to run in a folder nobody has trusted: /home/you/someones-repo
…
$ echo $?
77
```

Two ways past it:

- **Run `namzu` in the folder once** and accept the trust prompt. That is
  remembered in `~/.namzu/trust.json`, covers every subfolder, and is a
  one-time thing per project.
- **Pass `--trust`**, which accepts the folder for that run only. It writes
  nothing down — one reflexive use must not change your machine's state
  forever. For CI this is the intended form: it lives in the job definition,
  where a person reviewed it.

`--yolo` and `--permission-mode` do **not** imply `--trust`. Those decide which
tool calls may run *inside* a folder; trust decides whether the folder may be
worked in at all. An existing flag that satisfies a new gate is a gate
satisfied by accident.

This is not a sandbox and is not sold as one. It does not protect a folder you
trusted that later turns hostile — a pull can bring in anything, and trust is a
statement about a location rather than about its current contents. Inside a
trusted folder your [permission rules](./tools.md) and the safety gate remain
the only controls. What it changes is that a decision nobody was making is now
made by someone.

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
| `--trust` | Accept this folder for **this run**. See [The folder has to be trusted](#the-folder-has-to-be-trusted). |
| `--gate <command>` | A command that must pass before the run may finish. Repeatable. See [Gates](#gates). |
| `--gate-retries <n>` | Fix attempts a failing gate allows. Default 3. |
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

## Gates

```bash
namzu run --gate 'pnpm typecheck' --gate 'pnpm test' "fix the failing tests"
```

A gate is a command that must exit 0 before the run is allowed to settle. When
the model stops calling tools and is about to answer, the gates run; a failure
comes back as the model's next user turn — naming the command, the attempt, the
exit code and the output — and it tries again.

This is the unattended-operator flag. Without it, "fix the tests" ends whenever
the model believes it is done, and whether that is true is discovered later by
somebody reading CI.

Repeat the flag for several gates. They run **in order and stop at the first
failure**, because that is what a person means by "typecheck then test": a type
error makes the test output noise about the same cause, and showing the model
both invites it to fix the symptom. Repeating appends — it is not last-wins,
which would silently run only the last one.

### A gate is not re-run over a workspace nothing touched

If the model answers again having changed no file, the command is **not run a
second time**. The model is told the workspace is byte-for-byte identical to
what it was when that command failed, and that it must edit something before
trying to finish.

That is both cheaper — a test suite is usually the most expensive thing in the
loop — and a *different* instruction. Repeating the same failure hands the model
the same prompt that just failed to help it.

The attempt still counts. Skipping the command is a saving, not a pardon: an
answer that changed nothing has been rejected, and a run whose budget never saw
that would loop for free.

The change detector hashes `git status --porcelain`, the binary diff against
`HEAD`, and the contents of every untracked file — with a symlink recorded as
its target, so a link repointed at a different file is a change even when the
bytes behind it are the same. When it cannot tell — not a git repository, no
commits yet, git failed, output too large — the command **runs**. The cost of
re-running unnecessarily is one execution; the cost of wrongly skipping is a
verification that silently did not happen.

### When the attempts run out

The run stops with the stop reason `answer_rejected` and a non-zero exit. It
does not settle: an answer that never passed its gate has not passed it, and a
green run over a red build is the outcome the flag exists to prevent.

`--gate-retries <n>` sets how many attempts a gate gets (default 3). It bounds
both the gate and the run's rejection budget together, so the run cannot outlive
the gate and spend its remaining turns being told the gate has given up.

The same loop is available to any SDK host as `createCommandGate`, and the
detector on its own as `fingerprintWorkspace`.

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

### When the store will not cooperate

**A conversation that cannot be opened stops the run.** If `--session` is given
and the store cannot be reached — an unwritable `.namzu`, a corrupt map file —
`run-stream` emits an `error` event, runs nothing, and **exits `1`**. It does not
quietly fall back to the stateless path, because that path takes prior turns
from stdin: a caller who named a conversation would get an answer composed
against a different history, or none, reported as an ordinary success.

The exit code is `1` rather than `0` because a key is *created* on first use —
so this can never be a key you got wrong, only the store itself. Nothing you
send changes an unwritable `.namzu`, and a host treating `0` as "render the
error and move on" would loop on a fault it could have raised to a person.

It cannot be a warning-and-continue either, because the command cannot say what
was lost. A key is created on first use, so a fresh key legitimately has no
prior turns — and the failure is exactly what stopped it finding out which case
it is in. If you want the turn to run regardless, drop `--session`; that asks
for the stateless run explicitly.

**A turn that cannot be saved is reported and not fatal.** If the reply streamed
but appending it to the store failed, the run finishes normally and emits a
`notice` naming the reason and the consequence: `history` for that session will
not include the turn, and the next turn will not have it as context. It is a
`notice` rather than an `error` because the run genuinely succeeded — a host
treating it as a failed turn would be wrong — but silence here is what made a
later `history` look broken with nothing to connect it to.

## Exit codes

`namzu run` is written for `$?`:

| Code | Meaning |
| --- | --- |
| `0` | The model answered and the run finished normally. |
| `1` | The run failed, or stopped early — a token budget, a timeout, the iteration cap, a cancellation, or a refused answer. Any partial output is still printed, and the reason goes to stderr. |
| `2` | No prompt was supplied. |
| `64` | An argument is wrong (unknown option, bad `--cwd`), or a slash command was named and could not run — see [Your own slash commands](./tui.md#they-work-in-scripts-too). |
| `77` | The folder has not been trusted, and **nothing ran**. Fixed by a decision, not by a different invocation — see [The folder has to be trusted](#the-folder-has-to-be-trusted). |

A stopped run exits 1 even though it produced text, so
`namzu run … > out.txt && deploy` cannot proceed on a partial or refused answer.

`77` is its own code rather than folded into `64` or `1` because it is the only
one a human decision about a folder can fix, and a caller that cannot tell them
apart ends up matching on the message text — after which the message can never
be reworded.

### `run-stream`

`namzu run-stream` answers a host that is line-scanning stdout, not a shell, so
**every** failure is reported in band — including the ones that also carry an
exit code. Every run ends with a terminal event, refusals included:

```json
{"kind":"error","message":"--cwd does not exist: /projects/typo"}
{"kind":"done"}
```

The exit code answers one question, and only that one:

> **Can the caller reach the run it asked for by changing what it sends?**

| Code | When |
| --- | --- |
| `0` | **Yes.** An unknown option, no prompt, a `--cwd` that does not exist, a `--permission-mode` that is not a mode, an interactive command named headlessly, a provider id that is not a provider. Read the `error` event, fix the invocation, send it again. |
| `0` | A run that **started** and failed. That is an outcome to render, and possibly to retry. |
| `1` | **No.** A named conversation that cannot be opened, no provider available, a credential or driver the session needs, a declared tool server that is not there, a command file that will not parse. A person has to go and do something first. |
| `77` | The folder has not been trusted. Also "no", and kept its own code because only a human decision about a folder changes it. |

**This rule replaced one that did not sort the cases.** The old wording was
*started and failed → 0; refused to start → non-zero*, and by it an unknown
option, a missing prompt, a bad `--cwd` and an unavailable tool server were all
refusals to start — and all four exited `0` while an untrusted folder exited
`77`. The retry argument does not sort them either: retrying an unknown option
is exactly as pointless as retrying an untrusted folder.

`1` rather than a new code because `namzu run` — the same one-shot, differing
only in how it prints — already exits `1` for these conditions and `77` for
trust. A host that shells to one for a script and the other for a UI should not
be handed two tables for one fact.

**Dropping `--session` is not "the caller fixing it."** It abandons what was
asked for rather than achieving it, which is why a conversation that cannot be
opened is on the non-zero side.

**`--continue` and `--resume` are refused, not ignored.** They are `namzu run`
options; `run-stream` binds history with `--session <id>`. They used to parse
and do nothing, so a host that asked to reopen a conversation was given a fresh
one and told it had succeeded.

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
`deny` or **`review`**. The gate consults the safety floor, then your
[`permissions` table](./tools.md#the-permissions-file), then the read-only
allowance. `--permission-mode` says what happens to the calls that came back
`review` — the ones nothing decided either way.

| Mode | An undecided call is | Default when |
| --- | --- | --- |
| `prompt` | asked about | a terminal is attached |
| `auto` | approved | there is no terminal — every headless run, historically |
| `strict` | refused | never; you ask for it |

```bash
namzu run --permission-mode strict "run the test suite"
```

`strict` is the mode for an unattended run: **nothing executes unless the gate
allowed it.** Two things reach that bar. Read-only tools — `read`, `glob`,
`grep`, and the memory and task tools observe without changing anything, so the
gate allows them outright and they never reach the mode. And anything your
[`permissions` table](./tools.md#the-permissions-file) allowed by name or
pattern. Everything else is refused, and the model is told in the refusal that
asking again will not help, so it stops rather than rewording the same call.

Before `strict` existed an unattended run could only be `auto`, so a CI job
either trusted the agent with every tool it might reach for or could not use it
at all. `strict` makes a headless run something you can reason about: it can
look, and it can touch exactly what you wrote down.

```yaml
# a CI job that may run the tests and nothing else
permissions:
  bash:
    "pnpm test*": allow
```

Until `@namzu/cli` 0.7.0 the table was dropped before it reached the gate, so
`strict` meant read-only-tools-only no matter what you wrote. Adding an `allow`
is the difference between a job that can do one thing and one that can only
look.

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

Which rules the gate holds is set by the host that builds the session. `namzu`
runs it with its two standing policies — deny catastrophic shell patterns, allow
read-only tools — plus whatever your
[`permissions` table](./tools.md#the-permissions-file) compiles to. So the mode
is not the whole of the operator-facing control: the table decides calls, and
the mode only settles what the table left open. For the underlying rule
vocabulary a custom host can use, see [Tool Safety](../sdk/tools/safety.md).

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
and it is the one to use there. Passing either to `run-stream` is refused with
an `error` event naming `--session`, and exits `0` — the refusal is fixable by
sending a different flag. The two commands share one option parser, so the flags
used to parse and then do nothing: a host that asked to reopen a conversation
got a fresh one, reported as an ordinary success. This paragraph was already
true of the intent and false of the code.

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

## Picking up runs another process left behind

```bash
namzu drain --store ./state/runs \
  --tenant tnt_acme --project prj_api --session ses_nightly
```

`namzu drain` takes every run under that scope that no worker currently holds,
continues it from its last checkpoint, and releases it. It is a different shape
of command from the two above: those run *a* prompt, this one picks up work a
machine dropped.

**One pass, then exit.** `namzu serve` still answers that namzu has no daemon,
and this command is what that refusal implies rather than a retreat from it —
something a scheduler runs on whatever cadence the operator wants, not a service
namzu keeps alive.

| Option | Meaning |
| --- | --- |
| `--store <dir>` | The `runs/` directory a checkpoint store writes to. Required |
| `--tenant <id>` | Isolation boundary. Required; a listing with no tenant is a cross-tenant read |
| `--project <id>`, `--session <id>` | Required: the disk layout carries no attribution of its own |
| `--holder <id>` | Who is taking the runs. **Unique per process** — see below |
| `--ttl <ms>` | Lease length, default `600000` |
| `--max-concurrent <n>` | Runs in flight at once, default `1` |
| `--cwd`, `--provider`, `--model`, `--trust` | As `namzu run` |

There is no default `--store`, deliberately. namzu's own runs are not
checkpointed to disk today, so every run this can find was written by an SDK
host — and a default path would report "nothing parked" against a directory
nobody writes to, which reads exactly like an empty queue.

`--holder` must differ per process. It is the only thing distinguishing a
renewal from a theft, so two drainers sharing a string take live, unexpired
claims from each other instantly. Omit it and one is minted from the pid.

**A run parked on a human decision is reported, never resumed past.** The answer
belongs to a person; a drainer that continued without it would discard the
question the run stopped to ask. Those appear under `awaitingDecision`, separate
from `noCheckpoint` — one is a question waiting on somebody, the other is a dead
end, and they call for opposite responses.

Exit codes: `0` when every run it took was continued, `1` when any run failed or
the store could not arbitrate a queue, `64` for a bad argument, `77` for an
untrusted folder.

The loop underneath is `drainRuns`, which any SDK host can call directly —
including what it does and does not promise about processing a run only once.
See [State and persistence §4](../sdk/architecture/state-and-persistence.md).
