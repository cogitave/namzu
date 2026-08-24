---
uid: namzu.cli.reference
title: The operator application — sessions, commands, headless runs and configuration
description: Reference for @namzu/cli: what the interactive session does, every command and what it is for, how a headless run streams its events, the configuration surface and where it is read from, and what `namzu doctor` probes.
type: Reference
diataxis: reference
owner: cogitave/namzu
status: active
timestamp: 2026-08-24T00:00:00Z
lastReviewed: 2026-08-24
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

Four things happen on the way in, and they are the difference between a toy and
something you point at a real repository:

- **A folder nobody has trusted is not one it works in.** Launching in an
  unfamiliar working directory stops and asks, because reading files, running
  commands and editing code there is what it is about to be able to do. Accepting
  the prompt trusts the folder permanently; `--trust` accepts it for one run and
  deliberately does not remember. The trust screen is reached without reading
  that folder's `namzu.config.json`, project commands or project instructions;
  all three become active only after trust is established.
- **The repository gets to state how it wants work done.** `AGENTS.md` is read
  from the working directory upward to the repository root, outermost first, so
  the file nearest the work has the final word. Successful reads, writes and
  edits discover nested files during the same session; editing a known file
  reloads it. Each nested file applies only inside its directory subtree, and a
  sibling does not leak into another sibling's scope. The files currently in
  force are named on stderr, and one that was skipped is named with its reason —
  a refusal that says nothing is indistinguishable from a project that declared
  nothing.
- **It connects the tool servers you declare.** Each server's tools arrive
  prefixed with its name (`mcp_tickets_create`), so two servers offering `search`
  do not collide. A server that fails to start is named with its reason: the
  interactive session reports and carries on, because a person can read the line
  and decide, and a headless run refuses, because nobody is watching.
- **It reuses device sessions before asking for another credential.** A usable
  `Claude` or `Codex` CLI session is discovered from that tool's own credential
  file, including the paired Windows home when Namzu runs inside WSL. With no
  saved provider choice, one usable signed-in subscription starts directly; if
  both are available, a narrowed picker asks only which subscription Namzu
  should use and then starts its default model.
  Automatic single-session reuse is not persisted as if the operator had made a
  permanent choice. A Namzu-owned subscription login is the fallback for a
  machine with no usable external session, or an explicit operator choice; API
  keys are optional alternatives rather than a first-run requirement.

Inside the session, grouped by the question each one answers:

| | |
|---|---|
| **What is going on** | `/status`, `/debug-config`, `/cost`, `/permissions`, `/effort`, `/mcp`, `/tools`, `/model`, `/provider` |
| **What changed** | `/diff`, `/review`, `/expand` |
| **This conversation** | `/resume`, `/title`, `/goal`, `/fork`, `/new`, `/clear`, `/clear-screen`, `/compact`, `/copy`, `/raw`, `/export` |
| **What it knows** | `/memory`, `/remember`, `/skills`, `/skill`, `/init` |
| **Everything else** | `/help`, `/login`, `/logout`, `/feedback`, `/quit`, `/exit` |

Commands the kernel's own registry contributes are merged in beside them; a name
claimed by both raises an error rather than letting one silently shadow the
other.

Bare `/login` opens one combined subscription choice; it never silently defaults
to `Claude`. Every usable external device session is a `Use existing` row, and
starting a separate Namzu-owned credential is a distinct `Sign in to` row. A
signed-out, expired or otherwise unusable owner session is not advertised as
reusable. The shell equivalents are `namzu login claude` and `namzu login codex`.
`Claude` uses a registered browser flow whose returned code is pasted into the
picker or shell, while `Codex` uses a device code that can be approved in any
reachable browser. Both new-sign-in routes write only to Namzu's credential
store. The `Claude` route uses the direct subscription
authorization flow, not the platform/API-usage billing login. `/logout` and
`namzu logout` remove those Namzu-owned
records together; they never delete or revoke credentials owned by another
installed tool. The `l` sign-in action remains reachable from a general provider
picker even when an environment API key or local server was detected; discovery
does not turn those optional sources into a forced authentication choice.

Discovery order is intentional. A current external device session wins over a
Namzu-owned credential for the same provider, and a Namzu-owned credential wins
over an optional environment/API-key source. Alternative sources remain visible
in diagnostics, but fields are never blended between them. `Claude` is read from
its exact device credential envelope, `Codex` from its exact `auth.json` envelope
(honouring `CODEX_HOME`), and both reads are bounded and structurally validated
before a provider can be selected.

Bare `/permissions` opens a finite chooser for the effective tool-review mode;
`/permissions prompt`, `/permissions auto`, and `/permissions strict` remain
scriptable forms. They select how otherwise-undecided calls are handled on later
turns: ask the operator, approve automatically, or reject automatically. A
change is accepted only while the session is idle, and it revokes any earlier
**approve all** choice before publishing the new mode. Declarative deny rules
and the built-in safety gate remain authoritative in every mode. `--yolo` (the
`--dangerously-skip-permissions` alias) therefore chooses the initial `auto`
mode; it does not permanently remove the prompt boundary, and `/permissions
prompt` can narrow the same live session without reconnecting its provider or
tools.

Bare `/effort` opens a finite chooser containing the provider default and the
exact levels accepted by every usable member of the current provider/model
chain. `/effort <level>` applies that level to later main-query turns;
`/effort default` restores the provider default. Unknown model metadata disables
selection rather than inventing a menu, while an empty menu reports that the
chain explicitly offers none. A successful `/model` selection resets effort
before the replacement session or any paused queue is released; a failed or
cancelled selection keeps the current session and its effort unchanged.
Subagents and manual compaction continue to use their own provider defaults.

The one-line footer keeps the active model, reasoning effort and working
directory on the left. A durable goal state or a state-specific interaction hint
owns the right edge, so a deep path cannot hide `Goal stalled (/goal resume)` or
the key needed to leave a prompt. The idle footer does not repeat a permanent
key legend; the composer points to `/help`, while pickers and approval screens
name the keys that are active there.

While a tool is running, its live row shows the newest progress message and,
when the tool knows it, a percentage. Progress is bounded and coalesced under a
slow terminal rather than queued without limit; it is escaped at the terminal
boundary and disappears with the matching completed call. The complete tool
result remains in the transcript independently of this live projection.

The provider picker owns the asynchronous work started by the current choice.
Escaping, choosing again or leaving the screen cancels model discovery,
credential verification and subscription sign-in; a result that arrives later
cannot reopen a model list or accept a credential. Listing and verification are
also bounded to three seconds, including custom drivers that ignore their
cancellation signal. Cancelling subscription sign-in reaches the paste/token
exchange attempt, and no credential is written after the attempt is withdrawn.

When a provider's model listing explicitly includes `image` in
`inputModalities`, the model row is labelled `(image input)`. An absent modality
list gets no negative label: it means the driver did not establish the answer,
not that the model is text-only.

Between turns and before a durable resume, a lapsed **Namzu-owned** subscription
token gets one 30-second-bounded refresh attempt under that operation's
cancellation signal.
Concurrent operations in one session take this boundary in order and re-read
the credential only when they reach its head, so an earlier success cannot be
overwritten by a stale sibling. A credential in Namzu's own file is replaced
only when it still exactly matches the value that authorized the refresh; an
external rotation or logout wins. If that comparison cannot be published
safely, the operation refuses instead of using an uncommitted token.

A borrowed `Codex` device credential remains read-only and is re-read before
each operation. A borrowed `Claude` credential is also re-read from the exact
admitted file, but its refresh grant rotates: when Namzu must consume that grant,
it preserves the owner's complete envelope and atomically publishes the successor
access/refresh pair back to the same owner file. Keeping the successor only in
memory would log the owner client out. An owner rotation or deletion that lands first
wins; an unprovable publication refuses provider work. An already-invalid grant
cannot be recovered by either client and requires a new `Claude` sign-in.

An authorization server response of `400 invalid_grant` is not retried as a
transient outage. It means that exact refresh grant is no longer usable, so the
operation refuses before provider work and tells the operator to sign in again.
The live session remembers that refusal for the exact credential instead of
calling the endpoint on every turn; a newly signed-in or externally rotated
credential clears the condition by identity. Removing the authoritative
credential also refuses later sends and durable resumes — the provider object
left in process memory is not authority to keep using a logged-out token.

Credential-file mutation is protected by an atomically published owner lock.
A lock left by a crashed process is deliberately not stolen: pathname-based
stale recovery cannot prove that the entry it removes still belongs to the
owner it inspected. After proving that no Namzu process is using the store, the
operator may remove `~/.namzu/credentials.json.lock` and retry; until then login,
logout and token publication fail closed.

**Naming a conversation is what makes `/resume` navigable.** Without a name, a
conversation is listed by the first thing you typed in it — a reasonable default
and a poor identity, because it stops describing the work as soon as the work
moves on from that opening question. `/title <name>` fixes one in place, bare
`/title` reports the current one, and `/title clear` goes back to the derived
one. A named row is shown in quotes so the two kinds are distinguishable in the
list.

Resume authority comes from the current workspace, not from the globally
locatable session id or the fixed CLI topic id. The picker and `--continue`
therefore list only non-archived sessions under the Project selected by this
directory's `.namzu/cli.json`; stale Projects under the same store root cannot
contribute rows. Exact `--resume <id>` resolves that durable id directly rather
than requiring it to fit inside the 50-row recent index, but applies the same
Project and archive checks. A closed Project or archived Session remains
readable through history and export, while resume, keyed continuation, fork and
message mutation refuse before a new model turn. Namzu does not silently reopen
a tombstone: an archived SDK Session may be compensation for incomplete work,
and there is no general Session restore operation that could prove otherwise.
These checks establish the state observed at each operation boundary; a host
that closes a Project concurrently with a live turn must serialize those two
operations through its own durable lease.

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

A restored prompt can be much larger than the terminal needs to display. The
composer shows a bounded tail with a leading ellipsis and renders terminal
controls as visible escapes, while retaining the complete text and every
attachment behind that view. Editing and submitting therefore use the original
source rather than the shortened display.

**`/compact` replaces the older model-visible history with a summary.** It is
refused while a turn is running or an interrupted turn is still settling, and
input stays paused until the summary and its durable replacement have both
landed. A fresh conversation has user and assistant history but no prior system
floor; the command creates that floor from its retained summary instead of
declining the conversation shape the TUI itself stores. The next turn receives
that summary; leaving and returning through
`/resume` receives the same history rather than restoring the superseded turns.
The summary remains model-visible if that next turn itself needs automatic
overflow relief; a context-reduction retry cannot replace state inherited from
the earlier host-triggered pass with a summary built only from the newer run.
The disk log remains append-only: one replacement record changes the projected
conversation, and later turns append after it. Until that durable replacement
lands, the existing transcript and its context-fill gauge remain authoritative.
After publication the old gauge disappears with the superseded history; the
next model request supplies a fresh context measurement rather than the shell
presenting the pre-compaction percentage as current.

Manual compaction is owned by the same live session as a model turn. Replacing
or closing that session cancels and settles the pass before its provider and
tool-server resources are released; a compaction request made after close is
refused before provider work starts.

Automatic compaction updates that same gauge at the moment the kernel commits
its edit, before it starts the next model request. The cumulative token and cost
figures do not fall, but the context percentage does and is marked approximate
until a provider measures the new prompt. If that next request fails or stalls,
the reduced percentage remains current rather than reverting to the history
that was already replaced.

**`/goal` is durable operator control for what this conversation should
achieve.** `/goal <objective>` creates one, bare `/goal` inspects it, and
`/goal edit <objective>`, `/goal pause`, `/goal resume`, and `/goal clear`
change it under exact revisions. Control words are commands only when they are
the whole argument: `/goal pause after verification` creates that literal
objective. The command is handled by the host and is never itself sent to the
model as a prompt. Creating or explicitly resuming a goal arms automatic work;
bare inspection does not.

The goal belongs to the durable session, not to the screen or the working
directory. `/resume` therefore finds the same goal again. `/new`, `/clear`, and
`/fork` create another session with no inherited goal; the source keeps its own.
An unfinished goal cannot be silently replaced — edit or clear it explicitly.
A pending goal write also closes the input boundary until it settles, so a
later conversation switch cannot overtake the write and make its result appear
under the wrong session.

An armed goal continues through finite, durably admitted rounds. The default
cap is 256. Each round is reserved before provider creation, carries its exact
goal authority, and can use `get_goal` plus `update_goal`; ordinary human turns,
`/tools`, and subagents do not see those capabilities. A model may complete the
goal in any admitted round, but cannot report it blocked before round three.
Reaching the cap blocks it durably rather than starting unbounded work.

Human input wins the queue. A prompt typed while admission is on disk runs
before that reserved goal round, including later human prompts already waiting
behind the active turn. Interruption, abnormal provider settlement, failed turn
evidence, failed message persistence, or a conversation switch disarms
automatic work. Process restart and `/resume` restore durable goal state but do
not silently re-arm it; `/goal resume` on an already-active, disarmed goal is the
explicit retry. Goal rounds are shown as such rather than as operator messages,
retain that provenance through persistence and export, are excluded from the
previous-prompt editor, and suppress per-round settled notifications.

**`/clear` starts a fresh conversation and clears the terminal; `/new` starts the
same fresh conversation without clearing the terminal.** In both cases the old
conversation is unchanged and remains available through `/resume`, while the next
provider request starts with no prior model history. `/new` leaves earlier rows
visible only as scrollback and prints the boundary explicitly; those rows are not
silently sent as context. A running turn is interrupted and saved back to the
conversation where it started, and queued prompts for that conversation are
discarded rather than carried across the boundary. The new durable conversation
is created before any of that happens, so a failed store write leaves the current
context and running turn intact.

`/clear-screen` is the narrower display operation: it remounts an empty transcript
without changing model context, durable history, or the active conversation. It
exists for operators who want a clean terminal while continuing the same chat.
The transcript is only a view of model history; expanded `@file` contents and
image attachments can remain in that history after their readable token or
composer chip has left the screen.

Model history is published from the kernel's settled conversation projection,
not reconstructed from the text the terminal happened to render. Provider
reasoning blocks (including signatures and encrypted opaque payloads),
citations, assistant tool calls and their results therefore survive the next
turn, restart, `/resume` and `/fork` exactly. Native reasoning replay is also
bound to the provider, model, and fallback-chain member that produced it. The
same configured route resumes signed/reasoning tool continuations; changing
route preserves portable assistant/tool history but omits foreign native
metadata instead of presenting it as if the new model produced it. Missing or
edited replay state degrades the same way. Opaque reasoning is not shown in the
interactive transcript and is not added to `run-stream`'s live NDJSON event
channel. `namzu history --session`, whose contract is the raw model-visible
message array, includes it. Fresh identity, environment, memory and skill
system prompts are request context rather than conversation state: they are
rebuilt per turn and never copied into durable session history. Project
instructions are different: the current file set is a structurally tagged,
retained context snapshot. It is replaced rather than appended when scope
changes, survives compaction, and is persisted so `/resume` can rediscover the
same scopes. The files are re-read from disk on reconstruction; persisted
policy prose is not treated as fresh authority. Kernel-authored continuations,
review feedback, advisor output, steering, structured-output retries and task
completion notices can also occupy the provider's `user` role. They retain
runtime provenance in durable history, render as context rather than operator
input, remain outside the previous-prompt editor, and receive a separate
`Runtime context` heading in verified Markdown exports. A plain user/assistant
turn appends normally; a structural tool sequence or in-run compaction is
published as one atomic replacement so a crash cannot expose half a provider
turn.

The composer remains available while a turn runs. Return directs the complete
draft to that active turn; the SDK admits it only at the next provider-valid
response boundary, and the transcript keeps it as a pending steer until that
boundary is crossed. Tab addresses the next-turn FIFO instead. At idle either
key submits normally. Both paths retain pasted images and documents in provider
history and durable conversation rather than reducing them to display text. If
a session settles without draining a steer, it returns to the FIFO at the exact
position where the operator submitted it relative to Tab-queued work.

Ctrl+V and terminal Alt+V share the clipboard-image action; this is separate
from computer-use, which controls screenshots and pointer/keyboard automation.
Ctrl+W removes the preceding whitespace-delimited word, including punctuation
inside that word. The slash palette gives descriptions the terminal width left
after the longest visible command name. A short transcript pads between the
settled scrollback prefix and the live tail, keeping a newly submitted prompt
beside the composer instead of moving it under the banner.

Interrupting the active turn or switching conversations drops whole queued
prompts together, so an attachment cannot be stranded and sent somewhere its
text was not intended for. When a human turn fails or stops abnormally, work
already queued behind it pauses instead of running against a missing premise. A
new model-bound message, or a successfully published provider/model selection,
explicitly resumes the same FIFO; an automatic goal-round failure does not pause
independent human input. The terminal-settled notification fires at the pause
boundary because no queued work is immediately continuing.

The TUI buffers routine boot, provider and sandbox diagnostics so they cannot
corrupt an Ink frame. A crash prints the bounded buffer with its fatal error; a
clean Ctrl+C exit discards it and prints only the durable conversation id plus
the instruction to restart Namzu and use `/resume`.

Provider capability mismatches are transcript events, not log-only diagnostics.
Unsupported tools, images, and documents are named before the provider degrades
or refuses the turn, including the provider that made the declaration. This is
why a PDF or pasted image rejection reads as a capability boundary rather than
as an unexplained model failure.

Imported or resumed history can also contain an interrupted tool batch that a
provider would reject, or accept in a shape that invites the model to repeat a
side effect. When the kernel repairs abandoned history, the interactive
transcript adds a `History warning` before the next answer. It names whether the
source was fresh history or an abandoned checkpoint, reports only counts, and
reminds the operator to verify external state before retrying non-idempotent
tools. Tool inputs and results are not copied into the warning. A checkpoint
call still owned by an approval or crash-resume record is completed by that path
instead, so the warning never stands in for a durable human decision.

**`/copy` chooses source from the latest available assistant output and asks the
terminal to copy it.** The picker offers the whole response, every fenced code
block, and every blockquote that contains prose. Code copies omit the surrounding
fence; quote copies omit one structural outer `>` while retaining nested quote
markers. Line endings, trailing whitespace, Markdown and ordinary Unicode come
from the raw model response rather than being reconstructed from the rendered
screen. Labels and previews use terminal-safe visible escapes without changing
the selected source bytes.

The picker owns the response snapshot it opened with. A newer answer may settle
without retargeting an open selection, and no queued human or automatic goal turn
starts until the picker is selected or cancelled. While a new answer is streaming,
the previous normally completed answer remains available; a cancelled, guarded
or otherwise partial answer does not replace it. `/clear-screen` and `/compact`
keep the target. `/clear` and `/new` clear it with the model context; `/resume`
replaces it with the newest non-empty assistant output in the resumed conversation,
labelled as persisted because older durable records do not carry the stop reason
needed to prove a normal completion.

The selected region is refused outside an interactive terminal and above 100,000
UTF-8 bytes; oversized text is never truncated. A small code or quote region can
therefore still be copied from a response whose whole source exceeds the limit.
OSC 52 has no portable acknowledgement, so success means only that the request
was sent. A terminal, multiplexer or remote session policy may still ignore it,
and the UI says so rather than claiming the clipboard changed.

**`/raw [on|off]` changes the retained transcript between rich and literal
rendering.** Bare `/raw` toggles. Raw mode removes role glyphs and Markdown
styling, preserves Markdown source markers, and prints complete tool bodies
instead of collapse hints, so terminal selection does not have to reconstruct
source from a decorated view. C0/C1 terminal controls, lone carriage returns,
Unicode line separators and invisible directional formatting are painted as
visible ASCII `\u{....}` literals in both rich and raw modes. Newlines, tabs and
ordinary Unicode remain readable. This projection is terminal-only: model
context, permission/tool request objects, persistence, export and the target of
`/copy` retain the exact source.

The mode applies to the whole retained transcript, not only to rows produced
after the command. Switching it clears terminal scrollback, remounts the static
log and replays those rows in the selected form; `/raw off` performs the same
rebuild back to rich rendering. `/clear-screen` still removes the rendered rows,
so raw mode cannot and does not resurrect a view the operator deliberately
cleared.

The same projection applies before agent-authored tool text reaches the
permission overlay or the live activity row. A proposed command or write
preview therefore cannot ring, overwrite or reorder the consent screen before
the operator decides; the underlying request being approved is not rewritten.

**`/export [path]` writes a verified Markdown conversation, not a rendering of
the terminal.** Each new turn reserves its SDK run id and durably binds that id
to the exact user message before model execution begins. Export then reads the
run's strictly parsed event log and the survivor snapshot whose event boundary
matches that log. Raw assistant Markdown, model-visible tool calls and results,
provider fallback and context-relief activity therefore remain available after
`/clear-screen`; inline attachment bytes are represented by name and media type
rather than copied into the Markdown. After `/clear` or `/new`, `/export` targets
the fresh active conversation; resume the previous one to export its record.

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
| `namzu upgrade [--check]` | Check for or install the registry's latest CLI version in the npm-global prefix that owns the running package |
| `namzu login <claude\|codex>` / `namzu logout` | Store a Namzu-owned provider subscription credential, or remove all Namzu-owned subscription credentials |
| `namzu drain` | Continue runs another process left behind — one pass, then exit |
| `namzu eval` | Run eval suites and set an exit code |
| `namzu acp` | Speak the agent-client protocol over this process's stdio |
| `namzu serve` | Answers that there is no daemon: a run is an ordinary process |
| `namzu skills` | **Not implemented.** Prints a marker naming the milestone that will implement it, rather than answering "unknown command" |

`namzu upgrade --check` is read-only. Bare `namzu upgrade` recognizes the Unix
and Windows npm-global layouts from the package root that is actually running,
pins the registry's exact version in that prefix, then reads the same package
back before reporting success. A checkout or unrecognized package-manager
layout is refused instead of guessing from `PATH`. The interactive update
notice points to this command when npm reports a newer release.

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

## ACP sessions

`namzu acp` reserves stdout for newline-delimited protocol frames and keeps the
handshake lazy: `initialize` and `session/new` do not need a provider credential
and do not activate the target project's config. The first prompt checks stored
folder trust, pins the canonical working directory, then loads that project's
permission rules, tool servers and sandbox before constructing the model
session. An unfamiliar folder is refused in-band; there is no command-line
`--trust` shortcut for a client process to grant on a human's behalf.

One process may carry multiple wire sessions. Each gets its own `AgentSession`,
working directory, live event route, permission identity and exact settled
conversation. Different sessions may run concurrently without redirecting one
session's updates or cancellation into another. One session accepts only one
live prompt at a time, and its next prompt receives the settled provider-replay
history from the preceding turn rather than a transcript reconstructed from
what the client rendered. Reusing an id for another directory is refused, and
closing the connection closes every runtime session it constructed. Cancelling
a prompt settles it even while provider, tool-server or sandbox startup is
still pending; any candidate that arrives later is closed instead of used.
Cancellation also revokes its pending permission question: a late approval
cannot affect the next turn, and the stopped prompt reports `cancelled` rather
than `error`. Connection shutdown likewise cancels and settles every live
send, manual compaction and durable resume before closing that session's
external tool servers; a session never tears resources out from under its own
run.

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

With `--session`, `run-stream` persists the same exact settled conversation
projection as the interactive UI. Its stdout remains the live `AgentEvent`
protocol; opaque provider history is stored for the next turn and is available
through `namzu history --session`, but is never invented as an extra stream
event.

Without `--session`, stdin has a different contract from `namzu run`: the prompt
still comes from the command line, while optional stdin is one JSON `Message[]`
of prior history. Empty stdin means no prior history. Every accepted message is
forwarded exactly, including inline attachments, reasoning signatures/encrypted
blocks, citations, tool calls and multimodal tool results; missing optional
timestamps are not invented. A tool-call batch must be followed immediately by
exactly one result for every unique call id. Malformed JSON, invalid nested
fields, orphan/duplicate/unfinished tool sequences, arbitrary historical system
prompts (kernel compaction and working-memory state are accepted) and stored
attachment references (there is no attachment store in a stateless run) produce
`error` then `done` before provider probing. That is a fixable-input exit (`0`),
never a successful run against silently shortened history.

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

Resolution has a trust boundary as well as a precedence order. Before an
unfamiliar project is trusted, the CLI resolves only defaults, the user file,
environment and managed file — enough to render the gate under the operator's
own settings. It does not open the project config to decide whether the project
may be opened. After trust, it resolves the full cascade for the actual target
directory (`--cwd` for headless runs), then discovers project commands and
constructs the session. A malformed project config therefore refuses with exit
`78` only after that project has been accepted; before acceptance, the result is
the trust refusal (`77`) and no project bytes have been read. The real directory
approved by the gate is pinned for that launch, so repointing a `--cwd` symlink
after the decision cannot redirect config discovery or the session elsewhere.

`/debug-config` shows which source won each resolved top-level key, in a stable
order, and states the cascade separately. It deliberately receives and prints
no resolved values: the display answers which file, profile, variable or flag
to change without turning a diagnostic into a credential or command-argument
dump. A selected profile remains visible even when higher layers replace every
value it supplied. `--format` and `--quiet` are attributed to their exact flags;
profile selection says whether it came from `--profile` or `NAMZU_PROFILE`.

Paths, profile names and variable names are redacted with the same credential
patterns as logs, then rendered as quoted printable-ASCII literals. Control,
bidirectional-formatting and non-ASCII code points appear as visible escapes,
so a source name cannot add a terminal command, forge a row or make the shown
precedence read backwards.

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
`profiles` and `plugins`: nesting profiles would make "which one is active"
stop having one answer, while allowing `plugins` would let `NAMZU_PROFILE`
turn executable code loading on from ambient shell state.

**A profile name no file declares is refused, not ignored.** The error lists the
names that do exist and the files that declare them, because the mistake is
almost always a typo — and the alternative is running under settings nobody
chose while reporting success.

### Plugins

The CLI can own the SDK plugin lifecycle for an interactive session, `run`,
`run-stream`, `drain`, or an ACP session. It is deliberately off unless the
exact value `plugins.enabled: true` appears in a config file:

```json
{
  "plugins": {
    "enabled": true,
    "autoDiscovery": true,
    "allowedScopes": ["project"],
    "hookTimeoutMs": 5000
  }
}
```

Project plugins live under `<working-directory>/.namzu/plugins`; user plugins
live under `~/.namzu/plugins`. Once enabled, both scopes are admitted by
default. Set `allowedScopes` explicitly when only one authority should be read.
A disallowed scope is not scanned, and `autoDiscovery: false` scans neither.
The project scope is reached only after the existing trust gate has accepted
and pinned the project's real path.

That real project directory and the user's home directory are also the
lifecycle manager's filesystem roots. Discovery and installation canonicalize
each plugin before reading its manifest. A project or user plugin cannot use an
intermediate link to move outside its scope, and a symlinked `plugin.json` is
refused. Put the plugin tree physically below the selected root instead of
linking to executable code elsewhere.

This is executable-code authority, not a theme or metadata switch. A plugin
may import JavaScript tool and hook modules, load namespaced skills, and start
its declared stdio MCP servers. The CLI installs and enables every admitted
plugin before publishing the session; a refusal rolls back earlier plugin
contributions and closes connectors already opened for that candidate. A live
session uses the same manager and skill registry for ordinary turns and durable
resumes, and closing the session first cancels and settles provider work, then
uninstalls plugins and their MCP processes.

The SDK registry shown to the host is a lifecycle projection, not an authority
to replace executable roots or status. The CLI's manager retains the admitted
manifest and contribution ownership privately, so overwriting a registry row
cannot duplicate a plugin or make shutdown skip its hooks, tools, or MCP
clients.

Plugin skills are shown to the model by their namespaced metadata and loaded
through the `skill` tool only when requested. Plugin tools are namespaced and
deferred according to the SDK lifecycle. Hooks receive the run's cancellation
signal and the configured per-hook deadline. The current CLI scope is the
top-level agent session: delegated child agents keep their separate registry
and do not inherit executable plugin contributions.

There is no `NAMZU_PLUGINS` setting, and `plugins` is forbidden inside a
profile. A project file, user file or managed file therefore remains the
reviewable source that turns plugin code on. See [Plugins and MCP
Servers](../sdk/integrations/plugins.md) for manifest and module formats.

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

A readable source with a **known key whose explicit value is invalid** also
stops with exit `78`; it is not treated as if the key were absent. This applies
to the user, project and managed files, every declared profile body, and the
explicit `NAMZU_FORMAT` / `NAMZU_QUIET` variables. Each source is validated
before precedence is applied, so a malformed lower layer is still an error when
a higher layer could override it. The message names the source and exact setting
path, such as `sandbox.requireIsolation[1]`. An empty environment value is an
explicit invalid value; unset the variable to omit it. Invalid `--format` is a
command-line usage error instead and exits `64` before a command runs.

Unknown keys remain accepted and ignored for forward compatibility; this is not
a strict-config mode. Permission rules, permission checks and MCP server entries
also keep their existing per-entry compilers, which can name multiple bad entries
instead of losing the rest. Their outer container must still have the documented
shape. Every profile is validated when its file loads, selected or not, and a
profile name is an own key of the `profiles` mapping — inherited object names
such as `toString` are not declarations. A literal own profile with that name is
valid.

| Key | Shape | Notes |
|---|---|---|
| `format` | `'text' \| 'json' \| 'yaml'` | Default `text`. Also `NAMZU_FORMAT` |
| `quiet` | `boolean` | Default `false`. Also `NAMZU_QUIET` (`1`/`true`/`0`/`false`) |
| `permissions` | tool → effect, or tool → { pattern → effect } | Effects are `allow`, `ask`, `deny`. Absent means every mutating tool prompts |
| `permissionChecks` | list of `{ tool, input, expect }` | Checks the compiled permission table at startup and reports each mismatch or malformed entry |
| `profiles` | name → config mapping | Select with `--profile` or `NAMZU_PROFILE`; a profile cannot contain `profiles` or executable `plugins` |
| `mcpServers` | name → `{ command, args }` or `{ url }` | Tools arrive prefixed with the server's name |
| `plugins` | `{ enabled?, autoDiscovery?, allowedScopes?, hookTimeoutMs? }` | Default off. Exact `enabled: true` admits executable bundles; scopes are `project` / `user` and hook timeouts are positive integer milliseconds |
| `sandbox` | `{ enabled?, requireIsolation?, teardownTimeoutMs? }` | `enabled` defaults to **on**. `requireIsolation` lists the controls (`filesystem`, `network`, `process`) this machine must actually enforce, or the run refuses to start. `teardownTimeoutMs` defaults to `30000`; `0` restores the former unbounded wait |
| `telemetry` | `{ sessionExport?: { destination, eventTypes?, redactors? } }` | Writes run events to a JSONL file. `redactors: []` means no redaction and has to be written to mean it |
| `tui` | `{ notifications?, notificationMethod? }` | Interactive notifications; events are `turn-settled` / `approval-required`, method is `osc9` / `bel` |

Only `format` and `quiet` are settable from the environment. `telemetry` is
deliberately not: a variable in a shell profile could otherwise start exporting
conversation content with nothing in the config file to show for it. Plugins
are likewise file-only because enabling them imports executable code. Separately,
`NAMZU_LOG_LEVEL` and `NAMZU_LOG_FORMAT` govern the log records on stderr rather
than this config, and `--verbose` / `--quiet` on the command line beat them.

The resolved sandbox is session-scoped: ordinary turns, delegated child agents
and durable resumes use the same provider and teardown bound. Delegating or
resuming a run therefore cannot drop from the session's isolation boundary to
host execution. Set `sandbox.enabled` to `false` only when host execution is the
intended policy for every path.

```json
{
  "permissions": {
    "bash": { "git status*": "allow", "git push*": "deny", "*": "ask" },
    "write": "ask"
  },
  "mcpServers": {
    "tickets": { "command": "node", "args": ["./tickets-server.js"] }
  },
  "plugins": {
    "enabled": true,
    "allowedScopes": ["project"]
  },
  "sandbox": {
    "requireIsolation": ["filesystem", "network"],
    "teardownTimeoutMs": 30000
  }
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
`DEFAULT_CONFIG`, `ConfigLoadError`, `ConfigValueError`, `isFormatName` and
`runDoctorCommand` round out the surface. `ConfigLoadError` identifies a file
that could not be read or parsed; `ConfigValueError` carries its file/environment
source plus the exact known setting path whose value was rejected.

## Status

Published — the badge above is live, so it cannot go stale here — and dogfooded
in this repository, whose own `.namzu/` runtime state is written by this binary.

**Majors move quickly.** *Any* backward-incompatible change to a public API is
treated as a major however small the diff, so the version number tracks the
surface rather than the size of the work, and it climbs faster than you may
expect. Pin your dependency and read the changelog. The library surface listed
above is held by a baseline check in CI, so a symbol cannot quietly leave the
barrel between releases — but it can leave loudly, in a major.
