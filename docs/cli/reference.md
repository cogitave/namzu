---
uid: namzu.cli.reference
title: The operator application — sessions, commands, headless runs and configuration
description: Reference for @namzu/cli: what the interactive session does, every command and what it is for, how a headless run streams its events, the configuration surface and where it is read from, and what `namzu doctor` probes.
type: Reference
diataxis: reference
owner: cogitave/namzu
status: active
timestamp: 2026-08-18T00:00:00Z
lastReviewed: 2026-08-18
resource: packages/cli/src/cli.ts
tags: [cli, reference]
---

# The operator application — sessions, commands, headless runs and configuration

Bare `namzu` opens an interactive terminal agent. The same binary is scriptable:
one prompt and a printed reply, one prompt and a stream of newline-delimited
events for a host UI, a session's history as JSON, a health report, a pass over
runs some other process left parked.

It is built entirely on `@namzu/sdk`, in the same repository, out of the public
API — it exists as much to prove the kernel as to be used. The kernel renders no
UI, reads no config file and owns no terminal; everything in that sentence is
this package's job.

It is also a library. `runCli` is the whole shell as one call, and the doctor
registry, the config cascade, the output formatter and the capability probe are
exported on their own, for a host that wants the operator surface inside its own
process rather than behind a subprocess boundary.


## The interactive session

With a terminal attached, bare `namzu` launches the terminal UI. Without one — a
pipe, a CI step — it prints a single line saying an interactive session needs a
terminal and exits `0`, so a script that reaches the bare binary by accident does
not hang against a renderer with nothing to render into.

Three things happen on the way in, and they are the difference between a toy and
something you point at a real repository:

- **A folder nobody has trusted is not one it works in.** Launching in an
  unfamiliar working directory stops and asks, because reading files, running
  commands and editing code there is what it is about to be able to do. Accepting
  the prompt trusts the folder permanently; `--trust` accepts it for one run and
  deliberately does not remember.
- **The repository gets to state how it wants work done.** `AGENTS.md` is read
  from the working directory upward to the repository root, outermost first, so
  the file nearest the work has the final word. The files that were loaded are
  named on stderr, and one that was skipped is named with its reason — a refusal
  that says nothing is indistinguishable from a project that declared nothing.
- **It connects the tool servers you declare.** Each server's tools arrive
  prefixed with its name (`mcp_tickets_create`), so two servers offering `search`
  do not collide. A server that fails to start is named with its reason: the
  interactive session reports and carries on, because a person can read the line
  and decide, and a headless run refuses, because nobody is watching.

Inside the session, grouped by the question each one answers:

| | |
|---|---|
| **What is going on** | `/status`, `/cost`, `/permissions`, `/mcp`, `/tools`, `/model`, `/provider` |
| **What changed** | `/diff`, `/review`, `/expand` |
| **This conversation** | `/resume`, `/title`, `/fork`, `/compact`, `/copy`, `/export`, `/clear` |
| **What it knows** | `/memory`, `/remember`, `/skills`, `/skill`, `/init` |
| **Everything else** | `/help`, `/login`, `/logout`, `/feedback`, `/quit`, `/exit` |

Commands the kernel's own registry contributes are merged in beside them; a name
claimed by both raises an error rather than letting one silently shadow the
other.

**Naming a conversation is what makes `/resume` navigable.** Without a name, a
conversation is listed by the first thing you typed in it — a reasonable default
and a poor identity, because it stops describing the work as soon as the work
moves on from that opening question. `/title <name>` fixes one in place, bare
`/title` reports the current one, and `/title clear` goes back to the derived
one. A named row is shown in quotes so the two kinds are distinguishable in the
list.

**`/fork` continues in a copy and leaves the original where it is.** The
transcript on screen carries over, the next turn is written to the copy, and the
conversation you forked from is unchanged and still in `/resume`. The copy is
named after the original (`… (fork)`, then `… (fork 2)`) — both would otherwise
derive the same title and appear as two rows nobody could tell apart, which is
the list you would use to get back. It is refused while a turn is running and
while an interrupted provider iterator is still settling: `Esc` hands the screen
back immediately, but the partial reply still has to join and finish the durable
write queue. Once settled, the fork waits for that queue before copying, so it
cannot omit the reply you just watched or race a write already in progress.
The copied model context is published as one atomic replacement and read back
before the fork commits its lineage. That lineage is a flattened, immutable
list of source turns: later work in the source cannot appear in the branch, and
a fork of a fork does not depend on a live chain of moving boundaries.

**Esc twice on an empty composer edits an earlier prompt without rewriting its
source conversation.** The picker opens on the latest user message; Esc or left
steps toward older prompts, right steps forward, Enter confirms, and `q`
cancels. Confirmation creates a real fork immediately before that user message,
removes the selected turn and everything after it from the branch, then restores
the selected text and every image, document or stored attachment into the
composer. Editing the first prompt is valid and produces an empty-prefix branch.
The original remains byte-for-byte unchanged and resumable. If durable history
no longer exactly matches the selection, no branch is created; the operator must
open the picker again against the current conversation.

**`/compact` replaces the older model-visible history with a summary.** It is
refused while a turn is running or an interrupted turn is still settling, and
input stays paused until the summary and its durable replacement have both
landed. The next turn receives that summary; leaving and returning through
`/resume` receives the same history rather than restoring the superseded turns.
The summary remains model-visible if that next turn itself needs automatic
overflow relief; a context-reduction retry cannot replace state inherited from
the earlier host-triggered pass with a summary built only from the newer run.
The disk log remains append-only: one replacement record changes the projected
conversation, and later turns append after it.

The transcript is only the view of that history. Compaction remounts and trims
the view so the summary is visible before the recent rows, while the model record
keeps values the view cannot represent: expanded `@file` contents and image
attachments remain in later turns after their readable token or composer chip is
all that remains on screen. For the same reason, `/clear` clears the transcript,
not the conversation context or its durable record.

The composer remains available while a turn runs. A submitted follow-up waits in
FIFO order and carries the complete prompt, including pasted images, into the
provider request and durable conversation; queueing never reduces it to display
text. Interrupting the active turn or switching conversations drops those whole
queued prompts together, so an attachment cannot be stranded and sent somewhere
its text was not intended for.

**`/copy` asks the terminal to copy the latest available assistant output.** It
sends the raw, unrendered Markdown through OSC 52 instead of reconstructing text
from the screen or starting a host clipboard process. While a new answer is
streaming, the previous normally completed answer remains the target; a cancelled,
guarded or otherwise partial answer does not replace it. `/clear` and `/compact`
keep the target. `/resume` replaces it with the newest non-empty assistant output
in the resumed conversation, labelled as persisted because older durable records
do not carry the stop reason needed to prove a normal completion.

The request is refused outside an interactive terminal and above 100,000 UTF-8
bytes; oversized text is never truncated. OSC 52 has no portable acknowledgement,
so success means only that the request was sent. A terminal, multiplexer or remote
session policy may still ignore it, and the UI says so rather than claiming the
clipboard changed.

**`/export [path]` writes a verified Markdown conversation, not a rendering of
the terminal.** Each new turn reserves its SDK run id and durably binds that id
to the exact user message before model execution begins. Export then reads the
run's strictly parsed event log and the survivor snapshot whose event boundary
matches that log. Raw assistant Markdown, model-visible tool calls and results,
provider fallback and context-relief activity therefore remain available after
`/clear`; inline attachment bytes are represented by name and media type rather
than copied into the Markdown.

Bare `/export` writes `namzu-conversation-<session-id>.md` in the working
directory; an argument selects another path. The writer publishes through a
same-directory temporary file and never replaces an existing target. A legacy
conversation with no turn/run bindings, a fork whose copied prefix is not yet
tied to stable source turns, an unbound run, a torn event record, or a survivor
snapshot that does not match the event head is refused. Those states can still
contain useful history, but none can support the command's claim that the export
is complete.

New forks tie their copied prefix to source turns only after the copied model
history is atomically published and verified. A branch created before an edited
prompt maps the surviving durable prompt and answer back to one unique raw turn;
compacted older turns remain exportable through that lineage. If legacy history,
a partial persistence, or indistinguishable repeated turns make the boundary
ambiguous, the fork itself still preserves the model history but `/export`
refuses rather than choosing one lookalike source turn.

## Commands

| Command | What it does |
|---|---|
| `namzu` | The interactive terminal agent |
| `namzu run <prompt…>` | One prompt, headless. The reply goes to stdout, status lines to stderr |
| `namzu run-stream <prompt…>` | The same run, one JSON event per line, for a host UI that renders progress |
| `namzu history --session <id>` | That session's persisted messages, as JSON |
| `namzu skills-json` | The skills discovered for a working directory, as JSON |
| `namzu providers-json` | Providers and their per-provider models, as JSON |
| `namzu doctor` | Health checks against this machine |
| `namzu login` / `namzu logout` | Store, or remove, a provider subscription credential |
| `namzu drain` | Continue runs another process left behind — one pass, then exit |
| `namzu eval` | Run eval suites and set an exit code |
| `namzu acp` | Speak the agent-client protocol over this process's stdio |
| `namzu serve` | Answers that there is no daemon: a run is an ordinary process |
| `namzu skills` | **Not implemented.** Prints a marker naming the milestone that will implement it, rather than answering "unknown command" |

Options that belong to the program rather than to a command go **before** the
subcommand: `-f, --format text|json|yaml`, `-q, --quiet`, `-v, --verbose`,
`--log-format pretty|json`, `--dangerously-skip-permissions` (alias `--yolo`),
`-V, --version`. `namzu run "…" --verbose` is the order a person types and it is
refused, but the refusal names the option as positional — "try `namzu --verbose
<command> …`" — rather than handing back the generic advice about prompts that
begin with a dash, which is about the wrong half of that command line.

`namzu drain` deserves one sentence, because its shape is a decision rather than
a limitation: namzu has no daemon, so continuing parked runs is a command your
scheduler invokes, not a service that sits there. It takes every run under a
`--tenant`/`--project`/`--session` scope that no worker currently holds,
continues it from its last checkpoint, releases it, and exits. A run parked on a
human decision is reported, never resumed past — the answer belongs to a person,
and a drainer that continued without it would discard the question the run
stopped to ask.

## Headless runs

`namzu run` and `namzu run-stream` are the same one-shot differing only in how
they print, and they share one argument parser, so an option honoured by one is
honoured by the other.

```bash
namzu run "what does this repository build?"
echo "summarise this" | namzu run
cat notes.txt | namzu run "summarise this"
namzu run --cwd ../service --gate 'pnpm typecheck' --gate 'pnpm test' "fix the failing test"
```

Piped input is used rather than discarded. With no prompt argument it *is* the
prompt; alongside one it is appended as material the question is about, fenced in
a `<stdin>` tag so the last line of a file cannot run into the request. `namzu
run -` reads the prompt from stdin explicitly. Everything that is not an option
is the prompt — and an option this parser does not recognise is refused rather
than read aloud to the model, which is the worst available response to a typo.

| Option | What it does |
|---|---|
| `--cwd <path>` | Directory the agent works in. A path that is missing or is not a directory is refused, never silently ignored |
| `--provider <id>` | Replaces the provider chain with this provider alone |
| `--model <id>` | Re-models the existing primary and leaves the rest of the chain intact |
| `--skills <a,b,c>` | Load these skills as context for the turn, resolved under `--cwd` |
| `--session <id>` | Bind `run-stream` (and `history`) to a session |
| `--continue`, `-c` | Resume the most recent conversation here (`run`) |
| `--resume <id>` | Resume that conversation and no other (`run`) |
| `--gate <command>` | Must exit `0` before the run may settle. Repeatable; they run in order and stop at the first failure |
| `--gate-retries <n>` | Fix attempts a failing gate allows. Default `3` |
| `--permission-mode <m>` | `prompt`, `auto` or `strict` — what happens to a call no rule decided. `auto` when there is nobody to ask |
| `--trust` | Accept this working directory for this run only |
| `--yolo` | Alias of `--dangerously-skip-permissions`: resolves undecided calls to `auto`. It does **not** imply `--trust` |
| `--` | End of options; everything after it is the prompt verbatim |

`--continue` and `--resume` are `run` options and are refused by `run-stream`
rather than ignored. Neither ever falls back to starting a fresh conversation:
somebody who asked for a specific one and got a new one that looks the same finds
out several turns later, having already acted on it.

**`--gate` is the unattended-operator flag.** The run is not allowed to settle
until every gate command exits `0`. A failure comes back to the model as the next
turn, naming the command, the exit code and the output; a gate is not re-run when
the answer changed nothing on disk, because "the workspace is unchanged" is a
different instruction from repeating a failure the model has already been shown.
When the attempts run out the run stops with `answer_rejected` and a non-zero
exit — never a green run over a red build.

The two commands report failure differently, on purpose, because their callers
listen for different things. `run` answers a shell: `0` on a reply, `1` on a
failed or unfinished run (including one stopped by a budget, a timeout, an
iteration cap or a blocking guardrail, where the partial text still prints), `2`
when no prompt was supplied, `64` when an argument is wrong, `77` when the folder
has not been trusted and nothing ran. `run-stream` answers a line-scanning host,
so every failure is an `error` event on stdout and the exit code says only
whether the caller could reach the run by sending something else: `0` when they
could, `1` when they could not, `77` for the untrusted folder that only a person
can change.

## Configuration

Highest precedence first:

1. `/etc/namzu/config.json` — the machine's, if an administrator installed one
   (`%ProgramData%\namzu\config.json` on Windows)
2. Command-line flags
3. `NAMZU_*` environment variables
4. A selected profile, from whichever files declare it
5. `./namzu.config.json` — the project's
6. `~/.namzu/config.yaml` — the user's
7. Built-in defaults (`format: 'text'`, `quiet: false`)

### Terminal notifications

Terminal notifications are off unless the interactive UI opts in through the
`tui` table:

```json
{
  "tui": {
    "notifications": ["turn-settled", "approval-required"],
    "notificationMethod": "osc9"
  }
}
```

`notifications: true` enables both events. `false`, an empty list or an absent
value enables neither; a list selects only the events it names. This setting has
no environment-variable form, so a shell profile cannot start producing
notifications without a config file showing that choice.

`approval-required` is emitted when the approval prompt actually opens.
`turn-settled` is emitted only after the last immediately queued turn settles,
not between queued prompts. A normal end, an abnormal stop and a failure use
different fixed messages; manually interrupted turns emit none. Switching
conversations also revokes the abandoned turn's right to notify, even if its
provider iterator unwinds later.

The default method is `osc9`; `bel` writes a terminal bell instead. Both are
content-free terminal requests: they include no prompt, answer, tool arguments
or filenames, and start no host command. Neither protocol acknowledges display
or sound, so a successful write means only that the request was sent. Terminal,
multiplexer and remote-session policy may still ignore it.

### Profiles

A profile is a named bundle of settings **inside** a config file, so the
settings you switch between sit next to each other and can be read as a set:

```json
{
  "permissions": { "bash": "ask" },
  "profiles": {
    "ci":     { "quiet": true, "permissions": { "bash": "allow" } },
    "review": { "permissions": { "bash": "deny", "read": "allow" } }
  }
}
```

Select one with `--profile ci` or `NAMZU_PROFILE=ci`; the flag wins, because a
flag is this run and a variable is this shell. A profile overrides the base
values of the file it was declared in — otherwise selecting it could not change
anything — and is in turn overridden by the environment, so a variable set for
one shell keeps working after somebody picks a profile.

The same profile name may appear in both files. Each is applied as its own
layer, in the usual file order, so the project's wins *and* the boot log still
names the file each value actually came from. A profile may set anything except
`profiles`: nesting them would make "which one is active" stop having one
answer.

**A profile name no file declares is refused, not ignored.** The error lists the
names that do exist and the files that declare them, because the mistake is
almost always a typo — and the alternative is running under settings nobody
chose while reporting success.

### The managed file

`/etc/namzu/config.json` is read last and wins everything, including the
environment and the project file. It exists for the case where the person
running namzu is not the person deciding what it may do.

**Its guarantee is the file system's and nothing more.** namzu does not verify a
signature, does not check an owner, and cannot tell an administrator's file from
one a user wrote there. What stops a user editing it is that the path needs
privileges they do not have, on a machine somebody configured that way. That is
a real control and a narrow one, and the distinction matters: this is not a
sandbox for the config.

It is absent on almost every machine, which is the expected case and not an
error.

A file that is not there contributes nothing, and that is a default. A file that
**is** there and cannot be established — invalid YAML or JSON, a permission
error, a top level that is not a mapping — stops the CLI with exit `78` instead
of continuing on settings it failed to read. That refusal is load-bearing:
`permissions` is read from these files, so an unreadable config degrading to `{}`
would turn an operator's deny list into approval of the same calls, on the one
path where nobody is watching.

| Key | Shape | Notes |
|---|---|---|
| `format` | `'text' \| 'json' \| 'yaml'` | Default `text`. Also `NAMZU_FORMAT` |
| `quiet` | `boolean` | Default `false`. Also `NAMZU_QUIET` (`1`/`true`/`0`/`false`) |
| `permissions` | tool → effect, or tool → { pattern → effect } | Effects are `allow`, `ask`, `deny`. Absent means every mutating tool prompts |
| `mcpServers` | name → `{ command, args }` or `{ url }` | Tools arrive prefixed with the server's name |
| `sandbox` | `{ enabled?, requireIsolation? }` | `enabled` defaults to **on**. `requireIsolation` lists the controls (`filesystem`, `network`, `process`) this machine must actually enforce, or the run refuses to start |
| `telemetry` | `{ sessionExport?: { destination, eventTypes?, redactors? } }` | Writes run events to a JSONL file. `redactors: []` means no redaction and has to be written to mean it |

Only `format` and `quiet` are settable from the environment. `telemetry` is
deliberately not: a variable in a shell profile could otherwise start exporting
conversation content with nothing in the config file to show for it. Separately,
`NAMZU_LOG_LEVEL` and `NAMZU_LOG_FORMAT` govern the log records on stderr rather
than this config, and `--verbose` / `--quiet` on the command line beat them.

```json
{
  "permissions": {
    "bash": { "git status*": "allow", "git push*": "deny", "*": "ask" },
    "write": "ask"
  },
  "mcpServers": {
    "tickets": { "command": "node", "args": ["./tickets-server.js"] }
  },
  "sandbox": { "requireIsolation": ["filesystem", "network"] }
}
```

A pattern ending in `<space>*` also matches the bare command, so `git push *`
covers `git push`. A line that cannot be compiled is reported by name and the
rest still load — a permission somebody believes is in force and which was
silently dropped is the worst outcome available here.

**A rule about `bash` is a rule about the commands the line runs, not about its
text.** `git status && rm -rf ~` is two commands, and the table above says
nothing about the second one, so it is not allowed — an `allow` has to match
*every* command on the line. A `deny` is the mirror: it matches when *any*
command on the line matches, so `true; git push` is refused by
`"git push*": "deny"` exactly as `git push` is. Chain operators, subshell
grouping and a nested `sh -c` payload are all read, and quoting is respected, so
`echo "git push"` prints a string and trips nothing.

Two consequences worth knowing before writing a table:

- An `allow` declines a line that runs something the rule cannot see —
  `$(…)`, backticks, `<(…)`, `eval`. It falls through to being asked rather
  than being refused.
- A `*` on the left still loosens the match *within* a command
  (`"*git status*"` covers `sudo -u ci git status`), and no longer reaches
  across one. To approve every call to a tool, say `"*": "allow"`.

### Checking a table against what you meant

A table of globs cannot be read for what it does *not* cover, and that is the
half that matters. `permissionChecks` states the decision you believe each entry
produces, and every one is evaluated against the compiled table at startup:

```json
{
  "permissions": {
    "bash": { "git status*": "allow", "git push*": "deny", "*": "ask" }
  },
  "permissionChecks": [
    { "tool": "bash", "input": { "command": "git status --short" }, "expect": "allow" },
    { "tool": "bash", "input": { "command": "git status && rm -rf ~" }, "expect": "ask" },
    { "tool": "bash", "input": { "command": "true; git push" }, "expect": "deny" }
  ]
}
```

A mismatch is reported by index, naming the decision it got, the one you
expected, and the rule that decided — then the run continues, because a wrong
expectation should cost that line and not your whole policy. A check that cannot
be read is reported too, never skipped: "all checks passed" over a check that
never ran is the failure this feature exists to remove.

The dangerous-command floor is switched off while checking, on purpose. It would
answer for the catastrophic commands before any rule of yours was consulted, so
a check written about your table would be answered by something your table does
not contain — and would keep passing after the rule it was written for was
deleted.

`permissionChecks` is not settable from the environment. A variable that could
replace the checks could also empty them, silencing the one thing that says a
policy stopped meaning what its author wrote.

**A permission mode only decides the calls no rule decided.** A rule that denied
a call already stopped it and a rule that allowed one never asked, so neither
reaches the mode: `--permission-mode` can never reopen a `deny`. The
dangerous-pattern floor sits above both, and no mode reaches that either — which
is why `--yolo` promises more than it delivers, on purpose.

## `namzu doctor`

```bash
namzu doctor                              # human-readable, every category
namzu doctor --json                       # machine-readable report
namzu doctor --category sandbox,runtime   # sandbox, providers, vault, telemetry, runtime, plugins, custom
namzu doctor --per-check-timeout 8000     # default 5000
namzu doctor --wall-clock-timeout 20000   # default 10000
namzu doctor --verbose                    # repeat the failures, with their messages
```

The built-in checks, in the order they are reported:

| Check | Category | What it establishes |
|---|---|---|
| `sandbox.platform` | `sandbox` | What this host will actually confine — asked of the local sandbox provider, not answered from a table keyed on the OS name |
| `runtime.cwd-writable` | `runtime` | `W_OK` on the working directory |
| `runtime.tmpdir-writable` | `runtime` | `W_OK` on the temp directory |
| `providers.registered` | `providers` | Skipped: there is no provider auto-discovery, so a host registers its own check |
| `providers.credentials` | `providers` | Which credential sources were scanned, and what each yielded |
| `providers.chain` | `providers` | Which of the credentials found are actually wired into the chain, member by member |
| `vault.registered` | `vault` | Each registered credential provider's refs — *described*, never resolved, because this output gets pasted into issues |
| `sandbox.installed` | `sandbox` | `@namzu/sandbox`: absent, present, or installed and failing to load |
| `files.installed` | `custom` | `@namzu/files`, same three states |
| `computer-use.installed` | `custom` | `@namzu/computer-use`, same three states |
| `telemetry.installed` | `telemetry` | `@namzu/telemetry`, same three states |
| `logging.pipeline` | `custom` | What the log pipeline did to the records every check above just produced — dropped, redacted, truncated |
| `runtime.invariants` | `runtime` | Every registered invariant, folded with its violation counter |
| `telemetry.session-export` | `telemetry` | What this invocation's configuration would send off the machine, in a sentence |

Those four `*.installed` rows are the tri-state capability probe, not a
`try { await import() } catch`. Resolving and loading are asked separately so
that "not installed" and "installed and broken" cannot collapse into one answer:
the first is an optional package legitimately absent, the second is a machine
running degraded, and telling somebody who already has the package to install it
is useless advice.

Exit codes:

| Code | Meaning |
|---|---|
| `0` | Every check answered, and none of them failed |
| `1` | One or more checks reported `fail` |
| `2` | No checks registered — namzu is not configured here |
| `64` | An argument to `doctor` is wrong. Distinct from `70`: `70` says this CLI is broken and is worth a bug report, `64` says the invocation is |
| `69` | A check could not answer — it timed out, was aborted, or what it reads threw. Separate from `0` because a report that did not manage to look tells you nothing about the part it did look at, and separate from `1` because nothing was established to have failed |
| `70` | Internal CLI error |

A `skipped` check never moves the code off `0`. An optional package absent or a
registry with nothing to discover is an ordinary state of a healthy machine, and
a diagnostic that went non-zero on every healthy machine would be switched off
within a week.

The full page, including what each status word means, is
[`docs/cli/doctor.md`](../../docs/cli/doctor.md).

## As a library

The whole shell, as one call:

```ts
import { runCli } from '@namzu/cli'

process.exit(await runCli({ argv: process.argv }))
```

The reason to run the doctor in-process rather than shelling out to the binary is
visibility: `registerDoctorCheck` writes to a process-wide registry, so a check
your application registers is only seen by a `runDoctor()` in the same process.

```ts
import { registerDoctorCheck, runDoctor } from '@namzu/cli'

registerDoctorCheck({
  id: 'app.queue.reachable',
  category: 'custom',
  run: async () => {
    const url = process.env.QUEUE_URL
    if (!url) return { status: 'skipped', message: 'QUEUE_URL is not set' }
    const response = await fetch(`${url}/health`)
    return response.ok
      ? { status: 'pass', message: `queue answered ${response.status}` }
      : {
          status: 'fail',
          message: `queue answered ${response.status}`,
          remediation: 'Check QUEUE_URL and the broker credentials.',
        }
  },
})

const report = await runDoctor()
process.exit(report.exit)
```

`createDoctorRegistry()` returns an isolated registry for a test, and
`runDoctor({ registry })` runs against it instead of the singleton.
`builtInDoctorChecks` is the array the binary registers, exported so an embedder
can start from the same set. The individual checks are exported too —
`sandboxPlatformCheck`, `cwdWritableCheck`, `tmpdirWritableCheck`,
`providersRegisteredCheck`, `credentialSourcesCheck`, `providerChainCheck`,
`vaultRegisteredCheck`, `sandboxInstalledCheck`, `filesInstalledCheck`,
`computerUseInstalledCheck`, `telemetryInstalledCheck` — for registering a subset.

**Why the split runs where it does.** The doctor's protocol types
(`DoctorCheck`, `DoctorCheckResult`, `DoctorReport`, `DoctorStatus`) live in
`@namzu/sdk`, so a provider, a vault or a sandbox can implement a
`doctorCheck?()` hook against them without depending on an operator application.
The registry, the runner, the formatting and the exit codes live here, because
those are operator-facing concerns. The kernel owns the contract; this package
owns the presentation.

Also exported, and each of them is what the binary itself uses rather than a
parallel implementation:

```ts
import {
  createFormatter,
  loadConfigWithProvenance,
  NAMZU_OPTIONAL_CAPABILITIES,
  probeCapabilities,
} from '@namzu/cli'

const { config, provenance } = loadConfigWithProvenance()
console.log(config.format, provenance.format) // e.g. 'json' { kind: 'env', variable: 'NAMZU_FORMAT' }

const out = createFormatter('json', { quiet: false })
out.print({ ready: true })

console.log(NAMZU_OPTIONAL_CAPABILITIES)
// ['@namzu/sandbox', '@namzu/files', '@namzu/computer-use', '@namzu/telemetry']

for (const probe of await probeCapabilities()) {
  console.log(probe.specifier, probe.state) // 'present' | 'absent' | 'broken'
}
```

`ConfigProvenance` names which cascade layer won each key, down to *which*
`NAMZU_*` variable it was — "env" alone would not tell an operator what to
change. `loadConfig()` is the same cascade without the provenance.
`probeOptionalPackage(specifier)` probes one package instead of all four.
`registerCommand` / `registerAll` add a `CommandDef` to a Commander program, and
`DEFAULT_CONFIG`, `ConfigLoadError`, `isFormatName` and `runDoctorCommand` round
out the surface.

## Status

Published — the badge above is live, so it cannot go stale here — and dogfooded
in this repository, whose own `.namzu/` runtime state is written by this binary.

**Majors move quickly.** *Any* backward-incompatible change to a public API is
treated as a major however small the diff, so the version number tracks the
surface rather than the size of the work, and it climbs faster than you may
expect. Pin your dependency and read the changelog. The library surface listed
above is held by a baseline check in CI, so a symbol cannot quietly leave the
barrel between releases — but it can leave loudly, in a major.
