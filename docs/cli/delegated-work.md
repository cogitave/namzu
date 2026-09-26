---
type: HowTo
title: Delegated work
description: Launch independent child work, queue corrections and observe completion without losing ownership.
resource: packages/cli/src/integrations/subagents/runtime.ts
tags: [cli, agents, concurrency]
---

# Delegated work

The CLI builds its delegated turns with its own `NamzuCliAgent` in
`packages/cli/src/integrations/subagents/`. It uses the SDK's `QueryAgent`
adapter and `AgentManager`; the CLI chooses the child identity, prompt,
provider, tools and policy for each launch. The SDK's deprecated
`ReactiveAgent` name is not the CLI's agent taxonomy.

When the parent mounts independent `web_search` (Exa), delegated agents receive
the same search tool, including read-only `explore` agents. Each call owns its
connection and cancellation. Search remains subject to the parent’s authorization
rules. This does not enable search when it is off or substitute live Exa search
for an explicitly native/cached-only configuration.

Before constructing a delegated Anthropic client or querying its model catalogue,
the session rereads the selected credential owner. File-backed OAuth credentials
are renewed when needed, with concurrent renewals serialized; borrowed keychain
credentials remain owner-refreshed. A removed or still-expired credential stops
client construction instead of reusing the token captured at startup.

The `Agent` tool normally waits for its result. Set `run_in_background: true`
to receive the task UUID after launch and continue independent work. A queued
task is waiting for capacity; the receipt does not claim it has started or
completed.

Set `workspace: "worktree"` on an `Agent` call to give that child a separate
Git checkout. The default, `workspace: "shared"`, uses the parent's working
directory. Namzu creates the child checkout from the **committed HEAD of the
checkout running the parent**, including when the parent is already in a linked
worktree. Uncommitted parent files are absent. The child's file tools and
commands run from the new checkout, and its environment and project instructions
are read there. The checkout and any edits remain after success, failure or
cancellation. Completed results give its path and branch; live task listings
show them once the child is admitted. Use `namzu worktree list` to inspect it
later. Namzu does not merge the child's edits into the parent checkout.

A worktree launch is reviewed even for a read-only child, because creating a
checkout changes Git state. The permission review opens a compact task plan: each agent has one bracketed
row with its task and tool access, grouped by the supplied workflow and phase
labels. Background execution is marked on that row. Long rows wrap on narrow
terminals and large batches remain paged. Press `d` for full instructions and
exact prepared arguments; evolved input shapes still open in the exact view.
These labels do not imply dependencies or additional planned phases.
An optional `phase_detail` string adds explanatory text to a phase, shown
beneath its header in the compact plan and — in the agent cockpit — beneath
the phase list only while that phase is focused. It is display-only, exactly
like `workflow`, `phase` and `phase_order`: it creates no dependencies,
barriers or serial execution. The first agent to declare a phase's detail
sets it; a later sibling in the same phase cannot change it.

## Which launches are asked about

In `prompt` mode (the default with a person at the terminal) an `Agent` call
that starts a **read-only child on the session's own provider and model**
starts without the "Start an agent" review. That is:

- `subagent_type: "explore"`, or a project or user agent file with
  `readOnly: true` (a file that reuses the name `explore` is judged by its own
  `readOnly`);
- with no `provider`, no `effort`, and no `model` other than the session's own;
  and, for an agent file, no `model` in the file other than the session's own.

Starting such a child grants nothing by itself. Its roster holds only tools
that declare themselves read-only, so a `write` it asks for is not a tool it
has; and every call it makes is still reviewed under the parent turn's live
mode, exactly as before — a network tool such as `web_search` included. What
the operator is no longer asked is whether a reader may start. The cost it can
run up is bounded by the tree budget the turn already carries.

Every other launch is reviewed as before: a general-purpose agent, an agent
file without `readOnly: true`, and a read-only agent sent to another provider
or model or given an effort, or requesting `workspace: "worktree"`. A batch that mixes a read-only launch with any of
those is reviewed as one batch.

By mode:

| Mode | Read-only launch on the session model | Any other launch |
|---|---|---|
| `prompt` | starts | asked |
| `accept-edits` | starts | asked |
| `plan` | starts (reading is what plan mode is for) | refused with the plan-mode feedback |
| `strict` | refused unless a rule allows `Agent` | refused unless a rule allows `Agent` |
| `auto` | starts | starts |

**To keep every launch asked about**, as before this change, add an `ask` rule
for the tool: `"permissions": { "Agent": "ask" }` in `namzu.config.json` or
`~/.namzu/config.yaml`. An `ask` rule is an explicit review, which no
exemption skips; under it `plan` refuses a read-only launch again, as it did
before. `/permissions` says which launches start without asking.

Reviews identify the requesting agent by its exact child session ID in the activity monitor. If the child has not appeared in the monitor, the full session ID is shown instead of guessing an agent. This attribution stays with each queued review.

Concurrent permission requests are queued in arrival order. The current review
shows how many more requests await approval. Approving or declining it answers
only that request; the next review starts with a fresh consent window. Explicit
session-wide approval also approves requests already waiting in this queue.
Escape declines the current request; Ctrl+C rejects all pending requests and
stops the turn. Closing the application rejects unresolved reviews.

A child is reviewed under the parent turn's live permission mode, read at each
request. Plan mode entered with Shift+Tab while a child runs refuses that
child's next change with the plan-mode feedback, including one a `permissions`
rule allows and one of a kind the operator approved earlier in the child's
turn: the parent turn's "review even what the rules allow" switch reaches every
delegated turn (`resolveReviewAllowedCalls`, the SDK's
`AgentTaskContext.reviewAllowedCalls`). Leaving plan mode approves nothing
retroactively; a refused call stays refused. A paused turn continued with
`/resume` is decided under the mode the operator is in when they type it, read
at each request like a new turn's, so `/resume` in plan mode refuses the
resumed turn's changes and its children's, and Shift+Tab during it reaches
both. With nobody asked on a resumed turn, `prompt` and `accept-edits` approve
what the rules leave to review, as `auto` does, except a sandbox escape or a
path outside the roots, which is refused; `plan` and `strict` refuse. `namzu
exec` resumes under the mode the session was started with.

`send_message` takes `task_id` and `message` and queues a correction for a running
or queued child owned by the current parent session. The child reads it at its next
request boundary. Acceptance confirms queuing, not delivery or execution.
Messages are bounded to 16,000 characters. Finished tasks cannot be restarted
through this tool, and another parent's task cannot receive the message.

Once delivery is confirmed — never for a refused or unowned attempt — the
message becomes visible on both sides of the exchange. The child's transcript
(Ctrl+T, Enter to drill in) gets a `← from parent: …` row alongside its tool
calls and answers. The main conversation gets a matching row, `<description> ·
correction sent`, with the message text beneath it, so the operator can see
what was said without opening the child's screen. Each side shows the message
exactly once, however many times the surface re-renders.

`narrate_work` takes one `line` and shows it to the operator directly above the
agent rail, outside the rail's tree, in the parent's own voice. It starts,
corrects, stops and re-orders nothing: the line is commentary about work the
rail already reports, and no surface reads it back. Only the three most recent
lines stay on screen — a further line drops the oldest — each is clipped to one
row at 200 characters with a marker saying so, and a blank line is refused
rather than retained. Text longer than twice a row is not a line and the
schema refuses it, rather than reducing a paragraph to its opening clause; a
session that has stopped showing narration says that, rather than reporting a
perfectly good line as blank. The lines are cleared when the conversation is
reset, exactly like the agent rows beside them, and the band is in-memory only:
nothing replays it onto the screen after a resume.

The line itself is durable, and the difference is worth knowing before you
decide what to narrate. The call is recorded like every other tool call — it is
in the session log like every other call, and it returns
to the model's own history on `/resume`, long after the band that showed it is
gone. A line not worth writing down is a line not worth narrating.

The call is not reviewed: it declares itself read-only because it starts,
changes and stops nothing — no file of its own, no request, no task, and the
transcript record above is the kernel writing down a call, not this tool
reaching for anything — and asking the operator to approve being shown a line
would make the tool unusable. `send_message` and `cancel_agent`, which do
reach into a running child, are reviewed as they were. A successful call adds
no row to the conversation either: the line it wrote is already on screen, and
printing the call beneath it would show the same sentence twice, the second
time as protocol. A refused line keeps its row, because nothing was shown and
that is the only thing that says so.

The tool is mounted only where somebody is watching — the interactive
terminal, the same condition `ask_user_question` is mounted under. `namzu exec`
in either mode, `namzu drain` and the resident step have no rail for a
line to appear above, and a tool whose whole answer is "the operator saw this"
must not be offered where there is no operator to show it to.

The tool is the parent's alone. It is registered on the parent conversation's
registry, like `send_message` and `cancel_agent`, and a delegated child's
roster carries none of those — so nothing a child produces can be rendered as
the parent's own narration. That boundary is the design, not an oversight: a line
written by a child and shown as if the parent said it would be untrusted text
presented as trusted narration, which is what wrapping a child's output as
untrusted exists to prevent. If child narration is ever offered, it goes
through that same wrapping and is attributed to the child by name.

Each batch of agents one response launched adds one launch receipt to the main
transcript, `● Launched 2 agents · <workflow> / <phase>` with the agents named
beneath it, always below the text of the response that launched them, and each observed agent completion adds one named row, whether or
not the model calls `wait_for_task`: `✓ <name> · 1.7s · 9.0k tokens`, or
`✗ <name> · failed after 2.9s · <reason>`. A completed agent's final answer is
attached to its row, collapsed; Ctrl+O opens it, in place while the row is
live and in the output viewer once it has settled into history. A turn that launched agents
ends with `✻ Worked for <time> · <N> agents`, adding `in <N> phases` when the
model named two or more, the tokens the agents spent when any reported them,
and `<N> failed` when one failed. See
[Terminal design](terminal-design.md#delegated-work-in-the-conversation) for
the layout. When every running call is a correlated wait, the rows fold into
one `✻ Waiting for N agents to finish` line; a wait beside other work keeps its
own `Waiting · <task name>` row. Its successful protocol response does not add
a second report to the transcript. Unknown waits and tool errors remain
visible. Press Ctrl+T to inspect agent transcripts and results. Failed, cancelled
and incomplete work keeps its reported status rather than appearing completed.

The automatic rail stays on screen while an approval dialog is open, reduced to
its header line, so agents already approved can be seen working while the next
launch is decided. The reduced header names no key, since the dialog holds ↓
and Ctrl+T until it closes. Read-only launches start without a review; see
[Which launches are asked about](#which-launches-are-asked-about).

A workflow split into phases (one `workflow` label, several `phase` labels)
stays on the rail as one piece for the whole parent turn and is drawn by
phase: a settled phase as one line with its count and time, a live one with
its agents beneath it. The rail's header counts done agents across every
phase (`2/3 done`), with the time since the first started and the spend so
far. The agent cockpit opens on the phase that is still working. See
[Terminal design](terminal-design.md) for both.

Completion reaches the parent as a task notification. `wait_for_task` retrieves
the result without launching duplicate work. Background work keeps the same
parent authority, shared tree budget, capacity limit and cancellation boundary.
It is not a detached service: cancelling or releasing the parent turn cancels its
remaining children. A normal parent query waits for owned children before final
settlement, but can perform other tools and handle operator input meanwhile.

Workflow and phase labels describe the display; they do not establish execution
dependencies. Only delegate work that can proceed independently. The CLI's
`bash`, `write` and `edit` tools use [execution barriers](../sdk/tool-execution.md)
inside a model batch, so a following verification read sees completed foreground
mutations. A background shell command releases that barrier after job launch;
wait for the job before reading its eventual output.

Both kinds of annotation now reach a host the same way, on the child's initial
`agent_pending` event, so what separates them is what they mean rather than
where they travel. When an `Agent` call is associated with the active plan step,
the scheduler retains that plan and step identity while the child is queued and
after it is admitted, and SDK hosts receive `planId` and `planStepId` (SSE
consumers: `plan_id` and `plan_step_id`) — correlation a host may act on,
naming an approved plan edge the kernel also knows about. The `workflow`,
`phase`, `phase_detail` and `phase_order` supplied on the same call ride that
event too, as `workflow`, `phase`, `phaseDetail` and `phaseOrder` (SSE:
`workflow`, `phase`, `phase_detail`, `phase_order`), and they remain display
annotations only: they create no dependencies, barriers or serial execution, and
nothing in the kernel reads them back. Carrying them there is what gives the
grouping reach: a listener or SSE consumer outside this process sees the same
grouping instead of a flat list of children, where a label held in the tool
call's own memory would reach nobody. The workflow and phase are also recorded
durably, as the `batch` of the parent log's `child_session_spawned` record, so
a finished child keeps its grouping after a restart; the `phase_detail` and
`phase_order` display hints are not recorded.
Every one of these fields is absent unless supplied. See
[delegation events](../sdk/delegation-events.md) for the full event surface.


For parallel work, send the independent Agent calls in the same response or
launch them with `run_in_background: true` before waiting. One blocking call
followed by another is sequential. A wait released by operator input returns
the task name, ID and observed state; it does not cancel or restart the task.
The receipt directs the parent to answer the operator before further calls.
This is model guidance, not a deterministic guarantee about its next response.

The SDK also projects a bounded [owned-work snapshot](../sdk/step-context.md#derived-work-context)
before model requests. A task's scheduler state and delivery of its result are
separate fields: neither claims that the parent has summarized the result for
the operator. This keeps owned work explicit after a steering question without
duplicating worker output or adding another persistent task store.


`agent_task_list` reads the current parent session's actual scheduler invocations,
including pending, running and terminal tasks. It returns the most recent 40
with an explicit omitted count. `task_list` remains the planning checklist; an
empty checklist says nothing about running agents. `wait_for_task` retrieves
results by task ID. A budget or other non-normal stop is `incomplete`, even
when the scheduler lifecycle is `completed`; it is not a successful review.

Ctrl+T opens a dedicated agent browser using the terminal's available height.
The main composer is hidden there, with its draft preserved. Ctrl+T returns to
chat; Enter inspects a child transcript, Esc goes back and `q` returns from the
child to the parent. Workflows and phases remain navigation groups, not execution
dependencies. A phase's `phase_detail`, when supplied, is revealed beneath the
phase list only while that phase is focused — the other phases show none, and
a phase with no detail renders exactly as it did before this text existed. The
text wraps to the pane width and is clipped to a fixed number of lines, so the
pane's height never depends on how long the detail is. On a short terminal
(the cockpit's compact layout) the detail stays hidden entirely, the same way
the cockpit already drops its other secondary text there.

Each row in the automatic rail, the agent cockpit and the child transcript
header shows the child's status, elapsed time, description and — when the
host reported them — its resolved model and live counters: cumulative spend
compacted to `42.1k`/`1.38M` and a `N tools` tool-call count (the rail puts the
tool count and spend before the model, the cockpit after it), both drawn
from the same session events the transcript itself renders and never a percentage
or fill bar. Spend is the child's cumulative usage, not its current context
size, which is a different number that falls on compaction. A child that has
not yet reported usage shows an em dash rather than `0`, since the two are
different facts. On a narrow terminal the counters are the first thing
dropped, then the model name; the status, elapsed time and description remain
legible at any width this browser supports. A resolved model id is
host-reported, unbounded text — a self-hosted or gateway-style id can run
well past what a row has room for — so the label itself is capped to a short
budget with an ellipsis before it is ever placed next to the description,
rather than being shown in full and left to crowd the description out.

## Turn limits

Built-in children use the configured [turn limits](turn-limits.md), including
explicit unlimited values. `limits.maxIterations` now reaches built-in children
as well as the parent; absent or zero means unlimited. Built-in children also
default to unlimited turn duration. `/config` → limits changes these values
for newly started turns and their children without changing already running work.
`limits.timeoutMs` controls the parent and child turn deadlines. Delegation waits
remain cancellable and are governed by those turns, so a session-wide tool
deadline cannot override a later `/config` change. Zero removes the turn deadlines.
File-defined agents keep their own iteration settings and remain subject to the
shared token ledger. Disabling a local token cap cannot remove a finite ancestor
allowance.

## Child model selection

`Agent` accepts optional `model`, `provider` and `effort` fields. With no selection,
the child inherits the session model (or its file-defined agent model). A `model`
equal to the session's own, with no `provider` or `effort`, is the same as no
selection: the child runs on the session's provider and the catalogue is not
consulted, so it never lands on another provider that lists the same id. Over an
agent file that names another model, it is still a selection. Provider
and effort overrides require an explicit model. Selection creates a separate
provider instance and never switches the parent conversation. Explicit provider,
model and effort are visible in the compact approval plan and its detailed view. The child's tool
allowlist, read-only scope and review authority remain unchanged.

Use `agent_models` with an optional `query` filter to discover connected model IDs
and published capabilities. Results are bounded to 40 with an omitted count.
Unknown capability fields are not interpreted as unsupported, and the catalogue
is not an empirical quality ranking. Explicit model and effort selections are
validated before a task is created. Drivers whose effort menus come from model
discovery load their catalogue on each fresh validation/execution instance; unavailable selections are reported without
silently substituting another model.

CLI delegation has no implicit cumulative token cap when `limits.tokenBudget`
is omitted. An explicitly finite tree budget still constrains every child, and
usage remains recorded in unlimited mode. Other execution limits are unchanged.

## Cancelling one agent

`cancel_agent` takes the exact `task_id` returned by `Agent` or `agent_task_list`.
It requests cancellation only for a running or queued task owned by the invoking
parent session. Other tasks keep their ownership and cancellation signals. A finished
task returns its existing status without restarting or cancelling anything.
The receipt says cancellation was requested; use `agent_task_list` or
`wait_for_task` to confirm the terminal outcome. Task results still reach the
completion inbox once.

Cancellation during an unresolved provider stream can leave unknown token spend.
The ledger retains the unknown receipt and blocks its owning account and branches
sharing a finite ancestor budget. Healthy siblings under unlimited ancestors can
continue. `/cost` reports unresolved receipts and labels totals as measured,
potentially incomplete usage. Invalid accounting or failed persistence still
blocks the whole tree. A tool wait after a settled provider receipt does not
introduce this uncertainty.

## Saved delegation evidence after resume

A delegated agent runs in a child session, and everything it did is in that
child's own log, `<session-id>/subagents/<child-id>.jsonl`, beside a
`<child-id>.meta.json`. The parent's log records when each child was spawned
(`child_session_spawned`, with its workflow and phase as `batch`) and how it
ended (`child_session_ended`, with its status, usage and the id of its answer
message). Two readers use that evidence, and neither restarts anything.

### The receipt the model reads

New turns and checkpoint resumes take one bounded snapshot of this
conversation's earlier children, read through the session index
(`SessionIndex.listChildren`), which is derived from the parent log. A child
whose parent log has no `child_session_ended` yet is reported as
`unresolved`; one that ended carries its actual outcome and a preview of its
answer of at most 16,000 characters, explicitly marked when truncated. A
completed scheduler lifecycle does not turn a token-limited result into
success.

Use `agent_task_list({history: true})` to inspect the snapshot and
`agent_task_list({history: true, task_id: "<UUID>"})` to read one saved result.
The normal tool call still lists live tasks owned by the current session.
Historical access grants no cancellation, messaging or execution authority.

`unresolved` means the parent never recorded an end. It does not prove that the
child is still running, failed, or had no effects: a process that died mid-turn
leaves exactly that. Verify existing effects before deciding to repeat work.

History listings read at most 200 children and return at most 20 records; the
omitted count discloses the remainder. Exact-ID reads can retrieve a record
outside that listing. Model context includes at most eight earlier records and
omits the summary under tight context pressure. A child log that cannot be read
produces an error rather than an apparently empty history.

Children recorded by CLI 26.x and earlier, in the old `delegation-history/`
and per-run `children/` directories, are not read and do not appear.

### The evidence the operator can open

The child's log is the full durable record, not the receipt's 16,000-character
preview, and the agent cockpit opens it.

A child leaves the live monitor for two ordinary reasons: the monitor retains 80
agents and evicts the oldest beyond that, and a restarted CLI has no live monitor
at all. In both cases the cockpit lists the child from its log instead. Children
are discovered when a session starts, when `/resume` or `/new` changes which
conversation the CLI is in, and when the cockpit is opened; opening it waits for
that read rather than reporting an absence it has not finished checking. Saved
rows are marked `saved` beside the model and counters, and opening one shows
`Replayed from saved evidence. This child cannot be continued.` at the head of
the transcript. They never appear in the automatic panel above the composer,
which answers what is running now.

A replayed row is built by the same projection a live row is, so the two render
identically: status, elapsed time, model, cumulative tokens, tool-call count and
the transcript rows. Streaming deltas are not persisted, by design, but every
complete message is, so a replayed transcript carries the child's messages, its
tool calls, their results, any failure text and its final answer — only the
keystroke cadence in which the text arrived is gone. The workflow and phase
recorded on `child_session_spawned` group saved children exactly as they were
grouped live. See [delegation events](../sdk/delegation-events.md).

Replay is read-only. Opening a past child creates, moves and prunes nothing. A
log with a torn last line opens with the records that could be read plus a
closing row saying so; a log whose hash chain breaks opens up to the break,
with a row naming where it stopped, rather than refusing or silently showing a
short transcript. A log that cannot be read at all opens with that row alone,
beside what the parent recorded: a child whose evidence is damaged is still a
child that ran, and leaving it out of the list would say otherwise.

Resume does not restart these children or reconnect their processes, and
neither does opening one. A replayed child has no task the scheduler still
knows: `send_message` cannot reach it, `cancel_agent` has nothing to cancel, and
the screen offers neither.

### Finding a batch to reopen

`/agents batches` lists this conversation's batches — the groups of children
spawned together, derived from the `batch` annotations in the parent log —
newest first, with how many of each batch's agents are done and the tokens they
spent. A batch still going is read from the live monitor, and a finished one
from the session index, without reading any child log: reading one per row would
make the listing itself pay for what only opening a row needs. The read runs in
the background behind a loading row rather than holding the composer, and an
empty history says so rather than opening an empty picker. `/agents runs`, the
name before CLI 27, is an unknown subcommand and shows usage, like any other.

Each row's name is the batch's workflow label when one was set, and otherwise
the opening words of the parent turn that spawned it. Enter opens the selected
batch in the same cockpit `Ctrl+T` opens, landing directly on the first agent's
transcript, so a finished batch's `Replayed from saved evidence.` banner is the
first thing on screen. The listing is bounded: at most 20 rows, with an omitted
count when a conversation has more batches than that.

### Retention

Child logs accumulate under their parent's session directory. Nothing prunes
them: not the subagent runtime, not the agent manager, and not checkpoint
retention, which prunes checkpoints only. A project that delegates heavily grows
its state without bound, and reclaiming the space today means deleting a
session's `subagents/` directory — or the whole session — by hand. A prune
command is follow-up work, not something the view does behind the operator's
back.

Discovery is bounded even when the logs are not: a scan reads at most 2,000
sessions and replays at most the 80 most recent children, matching the live
monitor's own retention. The children are ordered before that second cap
applies, so the newest work is what survives it. That is a bound against an
unbounded scan, not a retention policy.

Agent transcript pages wrap prose at word boundaries. Long unbroken URLs or
code still wrap at grapheme boundaries, preserving all retained characters.
