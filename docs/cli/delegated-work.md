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

Delegated turns receive the parent's plugin lifecycle manager, resolved when the
child starts. Configured `subagent_start` shell hooks run once through the SDK's
normal lifecycle, with the child's session and turn ids, the invoking parent
session and turn ids, and `agent_type: namzu-cli`; the CLI does not emit a second
start notification. A name assigned to an `Agent` belongs to that parent
conversation: another conversation can use the same name without taking it over.

An ephemeral parent (`--no-session-persistence`) keeps its own log and checkpoints
in memory across sends and provider-pause resumes. Children inherit in-memory
storage too, including continuations; they do not fall back to the default disk
layout. Workflow journals and operator-message journals remain transient. An
absent transient checkpoint log is reported explicitly, never reopened from disk.
Closing the session discards its retained in-memory logs; restarting the process
cannot resume them.

When the parent mounts independent `web_search` (Exa), delegated agents receive
the same search tool, including the read-only `explore` and `plan` agents. Each call owns its
connection and cancellation. Search remains subject to the parent’s authorization
rules. This does not enable search when it is off or substitute live Exa search
for an explicitly native/cached-only configuration.

Before constructing a delegated Anthropic client or querying its model catalogue,
the session rereads the selected credential owner. File-backed OAuth credentials
are renewed when needed, with concurrent renewals serialized; borrowed keychain
credentials remain owner-refreshed. A removed or still-expired credential stops
client construction instead of reusing the token captured at startup.

## Built-in agent types

The `Agent` tool offers four built-in types beside any agent files:

| Type | Tools | Returns |
|---|---|---|
| `general-purpose` (default) | the parent's working set | the result of the task |
| `explore` | reading and searching tools only | an answer with paths and line numbers |
| `plan` | the same reading and searching tools | a step plan: the approach, numbered steps naming the files they change, the files to read first, and the risks and open questions |
| `fork` | the same working set as `general-purpose` | one report, written by a worker that has read this conversation |

`plan` is for the moment a design is wanted before code changes, without spending
the parent's context on exploration. It cannot edit, write or run commands. An
agent file named `plan` replaces the built-in of that name. Plan mode itself is
unchanged; see [Plan mode](plan-mode.md).

### The mode an agent file asks for

An agent file may carry a `permissionMode:` line: `plan`, `accept-edits` or `inherit`
(also accepted: `prompt`, `strict`, `bypass`, `auto`, which keep the parent's
mode as described below). By default a delegated agent is decided under the
mode of the turn that started it, as that mode is at each call. The line only
narrows that:

- a parent that asks before changes runs the agent in `plan` or `accept-edits`
  when the file says so;
- a parent in accept-edits, plan, auto, bypass or strict keeps its own mode in
  the agent, whatever the file says, and follows the parent when the operator
  switches;
- a file cannot ask for `bypass` or `auto`: the agent keeps the parent's mode.

A file with any other word on that line is skipped and listed with the other
unreadable agent files. The mode also applies when the agent is continued, including after a process restart: the current agent definition supplies its mode and the current parent turn supplies its review channel.

### Forks

`subagent_type: "fork"` starts a worker that continues the conversation instead
of starting from nothing. It is never the default: the model picks it when a side
task would fill its context with output it will not need again, such as an
open-ended survey, and a prompt that is only the directive (what to do, where the
scope ends) is enough, because the fork has read everything the model has.

What a fork inherits:

- the conversation up to and including the message that launched it, with every
  call in that message answered by a short note (its own says it started the
  fork) so the history is valid; a compaction summary is kept, the system
  message is not repeated. The copies are new messages in the fork's own
  conversation: they carry none of the ids the parent's saved conversation gave
  them, so a parent holding recorded messages and reminders starts a fork like any
  other;
- the system prompt of the conversation, used as it is;
- the model the turn runs on, including a scheduled job's;
- the sub-agent working set of tools, which has no `Agent` tool. This differs from the parent's own list, so the tool definitions are not shared with the parent's request.

When a child fails before it answers, its row and the parent's result say why in plain words.

What it does not get: its own `model`, `provider`, `effort` or `role` (the call
is refused when it names one), a way to start sub-agents or forks (a call from a
conversation that is already a fork's is refused too), or a saved description to
be rebuilt from after a restart. It may be given `workspace: "worktree"` like any
child; its directive then tells it that paths in the conversation point to the
parent's checkout.

Its result returns the way every child's does: a blocking call returns the
report, a background one sends a task notification, and the report is the
fork's final message. Reviews are unchanged: a fork launch is asked about like a
general-purpose one, and every call the fork makes runs under the parent turn's
live mode and rules. A fork sends the conversation again, so it costs about
what the conversation costs per request; a provider that caches the prefix
charges less for the repeated part. Launching one without a conversation to
continue (a workflow step, for example) is refused with a pointer to
`general-purpose`.

In the terminal the `Agent` tool runs in the background by default: it returns
the task UUID after launch and the model carries on, and it is told it will be
notified when the agent ends, so it neither sleeps nor polls. The model sets
`run_in_background: false` only when its very next step depends on the result;
that call waits for the result as before. There is no timer that moves a waiting
agent to the background. Headless hosts (`-p`, ACP, scheduled runs, an SDK
caller) keep the old default: the tool waits unless `run_in_background: true`
is set. A queued task is waiting for capacity; the receipt does not claim it has
started or completed.

### The turn does not wait for background agents

A turn ends when the model has answered, even though background agents it
started are still running; the composer is free at once, and what you type is a
new message, not a correction to the turn. Until the agents end, one dim line
under the answer says what is pending:

```
✻ Waiting for 2 background agents to finish
```

(`and 1 dynamic workflow` joins it when a workflow is running too.) A blank row
separates it from the line above. When the last one ends the line becomes the
turn's closing line, `✻ Worked for 3m 12s · done 3:45 PM · 2 agents`, with the
wait counted and the clock time the work ended right after the duration.

The model is told to pass what each finished agent found on to you in its next message: a result reaches the model, not you, so the notice that delivers it says you have not seen it, and the list of finished delegated work asks the model to check, before it ends a reply, that every finished result has been reported once.

Each agent that ends after its turn is over wakes the model. Everything that
ended while the conversation was idle goes to the model in **one** message and
produces **one** reply; one that ends while a reply is streaming is handed over
at the reply's next request. An agent you stopped yourself is not news and does
not wake the model.

- **Esc** interrupts only the model's reply. It never stops a background agent.
- **Ctrl+C** with a reply running interrupts the reply and leaves the agents
  alone. With nothing running it stops every background agent, says `All
  background agents stopped` and tells the model once (`Background agent "X"
  was stopped by the user.`); that one row is all the conversation gets for the
  stop: no `was stopped by user` row per agent and no `Worked for` line
  splitting it. The exit reminder only appears when no agent is left. In an agent's own view it stops only that agent and returns to the main
  conversation.
- Closing the conversation or the terminal stops the agents, as before.

Foreground agents (`run_in_background: false`) keep their old behaviour: the
call waits, Esc and Ctrl+C stop them with the reply, and the result comes back
inline.

Set `workspace: "worktree"` on an `Agent` call to give that child a separate
Git checkout. The default, `workspace: "shared"`, uses the parent's working
directory. Namzu creates the child checkout from the **committed HEAD of the
checkout running the parent**, including when the parent is already in a linked
worktree. Uncommitted parent files are absent. The child's file tools and
commands run from the matching directory inside the new checkout when the
parent started below the Git root (for example, `packages/foo`). Its environment
and project instructions are read from that directory. The reported worktree
path and branch still name the checkout root. When the child ends with no
uncommitted changes and no new commits, Namzu removes the checkout and its
branch, and the result says the worktree had no changes and was removed. A
checkout with changes or commits stays after success or failure, and the
result gives its path and branch; live task listings show them once the child
is admitted. A cancelled child's checkout stays. Use `namzu worktree list` to
inspect what remains. If that nested directory is absent from the committed checkout, the
child does not start. Namzu does not merge the child's edits into the parent
checkout.

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

## Workflows are not subagents

The model can also start a **workflow**: a script, written once and approved by
the operator, that starts many agents under phase titles it chooses. A
workflow's agents are real children, with their normal transcripts, under the
same permission mode, rules, sandbox and token budget as `Agent` calls; but
they are the script's agents, not the model's, so they are never rows of the
agents rail, never get launch or completion rows, and are not counted in the
turn's summary line. The run is one rail row and one detail view. See
[Workflows in the CLI](workflows.md). Agents the model gives a `workflow` label
through the `Agent` tool stay as described here; the two share the rail row and
the detail view's shape, not their code path.

## Agent files

A Markdown file in `~/.namzu/agents/` or `<project>/.namzu/agents/` defines an
agent type the `Agent` tool offers; the project's file shadows the user's of
the same name. The frontmatter says what the agent is, the body is its system
prompt. Only `name` and `description` are required. Every list is one
comma-separated line.

| Key | Meaning |
|---|---|
| `tools` | Allowlist, intersected with the parent's tools. |
| `disallowedTools` | Tools removed from the roster, even when `tools` names them. |
| `readOnly` | `true` keeps only tools that declare themselves read-only. |
| `model` | The agent's model; `inherit` (or no line) keeps the session's. |
| `effort` | Reasoning effort: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` or `ultra`. A model that does not support it runs without. |
| `maxTurns` | A positive whole number; the agent stops after that many turns, or at the session's own limit when that is lower. |
| `background` | `true` starts the agent in the background when the call does not say; `run_in_background: false` on the call still waits. |
| `isolation` | `worktree` gives the agent its own Git checkout, like `workspace: "worktree"` on the call, and the launch is reviewed. |
| `skills` | Skills whose instructions are added to the agent's prompt. One that is missing or disabled is left out and logged. |

A file with a value it cannot use is refused with its path and the reason
rather than loaded with the line ignored; the other agents still load.

## Which launches are asked about

In `prompt` mode (the default with a person at the terminal) an `Agent` call
that starts a **read-only child on the session's own provider and model**
starts without the "Start an agent" review. That is:

- `subagent_type: "explore"` or `"plan"`, or a project or user agent file with
  `readOnly: true` (a file that reuses the name `explore` or `plan` is judged by
  its own `readOnly`);
- with no `provider`, no `effort`, and no `model` other than the session's own;
  and, for an agent file, no `model` in the file other than the session's own.

Starting such a child grants nothing by itself. Its roster holds only tools
that declare themselves read-only, so a `write` it asks for is not a tool it
has; and every call it makes is still reviewed under the parent turn's live
mode, exactly as before — a network tool such as `web_search` included. What
the operator is no longer asked is whether a reader may start. The cost it can
run up is bounded by the tree budget the turn already carries.

Every other launch is reviewed as before: a general-purpose agent, a fork, an agent
file without `readOnly: true`, and a read-only agent sent to another provider
or model or given an effort, or requesting `workspace: "worktree"` (an agent file with `isolation: worktree` included). A batch that mixes a read-only launch with any of
those is reviewed as one batch.

By mode:

| Mode | Read-only launch on the session model | Any other launch |
|---|---|---|
| `prompt` | starts | asked |
| `accept-edits` | starts | asked |
| `plan` | starts (reading is what plan mode is for) | refused with the plan-mode feedback |
| `strict` | refused unless a rule allows `Agent` | refused unless a rule allows `Agent` |
| `bypass` | starts | starts |
| `auto` (the classifier) | starts | decided by the classifier like any other call that `prompt` would ask about |

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
request. An agent file may narrow the inherited mode as described above; it cannot grant `bypass` or `auto`, and a child runs in `bypass` only while its parent does ([Permission modes](permission-modes.md#sub-agents)). Plan mode entered with Shift+Tab while a child runs refuses that
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
what the rules leave to review, as the unattended default does, except a sandbox escape or a
path outside the roots, which is refused; `plan` and `strict` refuse. `namzu
exec` resumes under the mode the session was started with.

`send_message` takes `task_id` and `message`. The task may come from any turn of
the conversation, running or finished. A running or queued child of the
conversation is sent the message for its next tool round
("Message queued for delivery … at its next tool round"); acceptance confirms
queuing, not delivery or execution. A **finished** child is resumed from its own
transcript with the message ("Resuming agent …") and notifies again when it
ends. A child the user stopped is refused: "Agent … was stopped by the user and
was not resumed. Treat its work as cancelled; only start a new agent for it if
the user explicitly asks." A resumed child runs under the current turn's limits
and review channel. Messages are bounded to 16,000 characters. An id that no
agent of this conversation has, including one of another conversation, gets the
same answer: "No task with ID … in this conversation.", followed by "Running
agents: …" when any are running and, only when the id is a saved agent's session
UUID, a pointer to `agent_task_list` with `history: true`; a value that is not a
UUID gets the same answer, and nothing is sent and no row is added. While a
resume is being admitted the three tools answer about the new run, and an agent
that is still unwinding after a stop answers that it is stopping.

`Agent` takes an optional `name`: letters, digits, underscores and hyphens,
starting with a letter or digit, at most 64 characters. The name then stands in
for the task id in `send_message`, `wait_for_task` and `cancel_agent`
(`task_id: "reviewer"`), the launch receipt repeats it, `agent_task_list` shows it
as `name`, and the "Running agents" list of an unknown-task answer prints it in
brackets. Names match without regard to case, width or spaces. `main`,
`team-lead`, `user` and `system` are reserved, and so is anything shaped like a
task or run id; such a launch is refused with the reason and starts nothing. A
later agent given the same name takes it over. A name lives as long as the
conversation keeps the agent.

An agent keeps one task id for as long as the conversation knows it. A resumed
run is a new task inside, but the notification, `agent_task_list`,
`wait_for_task` and `send_message` all show the id the agent was first known by,
and that id keeps working for `wait_for_task`, `cancel_agent` and
`send_message`. When two messages meet an agent that is being resumed, the
second is told in plain words that the agent is already being resumed and to
wait for its notification before sending another. A saved agent that is still
running its earlier work answers that the message was not sent and to try again
in a moment.

A running child has a `send_message` of its own with `to: "main"` and a
`message`, offered only while the host can show the message (the interactive
terminal). The text is queued for the conversation's next turn ("Message queued
for the main conversation's next turn."), shown as `› Message from @<type>
(ctrl+o to expand)`, and handed to the model framed as the child's own words,
not the operator's and not proof of any permission. It wakes an idle
conversation and never releases a wait the running turn is in. Another
recipient, or a blank message, is refused in plain words; a child that was
stopped is told it cannot send and to put what it needs in its final response.
The operator does the same by
viewing the agent and typing (see
[Terminal design](terminal-design.md)): queued for a running agent, resumed for
a finished one, refused for a stopped one.

Once queue acceptance is confirmed — never for a refused or unowned attempt — the
message becomes visible on both sides of the exchange. The child's transcript
(rail Enter, or Ctrl+T then Enter) gets a `← queued from parent: …` row alongside its tool
calls and answers (what the operator typed to it reads as their own `❯ …` row).
The main conversation gets a matching row, `<description> ·
correction sent`, with the message text beneath it, so the operator can see
what was said without opening the child's screen. Each side shows the message
exactly once, however many times the surface re-renders. While the child has
not taken a message in, its rail row says `N queued` after the clock and the
spend (`↓ 42.1k tokens`).
These rows record acceptance; they do not acknowledge that the child model
read the message or completed the requested change.

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
transcript, `● 2 background agents launched (↓ to manage)` with each agent's
description beneath it, always below the text of the response that launched
them. A batch that includes an agent the turn waits on is a live group while it
runs, `Running 3 agents…` with one block per agent (`description · 4 tool uses ·
12.1k tokens` over `⎿ <last tool>`, or `Initializing…`), and writes its receipt,
`3 agents finished`, when the last member ends; the manage hint is only for an
all-background batch. Each observed agent completion adds **one** row, whether or
not the model calls `wait_for_task`: `● Agent "<description>" finished · 1m 4s
(ctrl+o to expand)` with the agent's answer behind Ctrl+O (the detailed transcript), or
`failed: <reason>` (no duration), `was stopped by user · 1s`, `was stopped by Namzu · 1s`
when the conversation's own agent cancelled it, or `was stopped · 1s`, with no
token count and no repeat of the result. The separate `Message from @<type>` row
now belongs only to a running agent's own `send_message`. Only an agent that runs on its own
(a background launch, one whose wait was released, one a later message resumed)
reports this way; an agent the parent waited on hands its result back inline
and leaves the tool's own result instead, `● <type> (<description>)` over
`⎿ Done (3 tool uses · 12.1k tokens · 8s)`. Agents the model
gave a `workflow` label are the exception: they are one workflow, not agents.
Their launch writes a single `● Workflow <name>` line with
`⎿ Running in background · ↓ to manage` beneath it, they leave no per-agent
receipt or completion row, and the workflow closes with one line
(`✓ Workflow <name> completed · 4m02s · 7 agents · 112.0k tokens`). A turn that
launched agents ends with `✻ Worked for <time> · done <clock> · <N> agents`, adding the tokens
the agents spent when any reported them and `<N> failed` when one failed; it
never counts phases, which appear only in a workflow's detail view. See
[Terminal design](terminal-design.md#delegated-work-in-the-conversation) for
the layout. When every running call is a correlated wait, the rows fold into
one `✻ Waiting for N agents to finish` line; a wait beside other work keeps its
own `Waiting · <task name>` row. Its successful protocol response does not add
a second report to the transcript. Unknown waits and tool errors remain
visible. Press Ctrl+T to inspect agent transcripts and results. Failed, cancelled
and incomplete work keeps its reported status rather than appearing completed.

The agents rail stays on screen while an approval dialog is open, reduced to
its `main` row and a count, so agents already approved can be seen working
while the next launch is decided. That row names no key, since the dialog holds
↓ and Ctrl+T until it closes. Read-only launches start without a review; see
[Which launches are asked about](#which-launches-are-asked-about).

`ctrl+x ctrl+k` stops the running background agents from the composer or the
rail. With none running it says `No background agents running`; the first
press shows `Press ctrl+x ctrl+k again to stop background agents` in the footer for
3 seconds (it is not a transcript row); the second stops them and leaves
`All background agents stopped` (the same single row as Ctrl+C). Agents
the parent is waiting on (foreground) are stopped one at a time with `x`.

A background agent's notice row colours only its `●` by outcome (green, red for a failure, warning for a stop); its sentence is plain primary text. A failure's sentence is the error's own text on one line (whitespace folded, wrapped at the terminal width, never cut), and the row carries no duration and no expandable body. `failed again` compares that text.

A failed agent shows the error text the agent produced, verbatim and in the
error colour, in three places. In the conversation the failed `Agent` call shows
it under the call as `Error: <text>` (a text that already starts with `Error: `
or `Cancelled: ` is shown as it is, an input-validation error is shortened to
`Invalid tool parameters` until expanded, and a call with no text says `Tool
execution failed`): the first 10 lines, then a dim `… +N lines (ctrl+o to
expand)` (counted in the text's own lines; each line is wrapped to the width at
word boundaries), and every line when expanded. In the agent's own view the error is a
section of its own: a blank line, a bold `Error` heading and the whole message,
wrapped. In a workflow's agent list the agent's row ends with ` — <error>` on
one line. An agent that fails again with the same reason after a
message reads `failed again`. Messaging a finished agent keeps its row where it
was, with the time and spend it had, and writes `Continuing with a new task.`
in its own transcript.

The model's reply is committed to the transcript when the model finishes it, not
when the turn settles, so its last sentence is on screen while the turn waits on
background agents and the agents' notices print after it.

The rail lists running agents, plus a failed or stopped one for 30 seconds (a
background agent that completed leaves at once), five at a time, one row each
(type, description, time and spend; every row has the type column, however many
agents there are or what the others are doing). A running background agent's live label sits beside its clock: every 30 seconds, when it has done something new
and has at least three messages, it is asked once on its own model, with no
tools, for a three-to-five-word present-tense label naming the file or function,
in the predominant language of what the agent has been doing (there is no
language setting to read); one line of at most 100 characters is kept, anything
else is dropped, and the label goes when the agent ends. The request is counted
on the turn's token ledger, on a small account reserved for it and settled
afterwards (at most 8,000 tokens from a limited turn), and is skipped when the
turn has no room or its own request is in flight. Agents inside a
`workflow` run keep their `label`. ↓ in an empty
composer moves into it, where Enter views an agent on the main screen (the one
composer stays live and talks to it) and `x` stops it. Workflows and subagents are kept apart. A
subagent is an agent the model started without a `workflow` label: it has an
agent row. A workflow is the set of agents started with the same `workflow`
label: it has no agent rows at all, only one row after the agent rows (`◯ name
▰▱ bar  3/7 · 2m14s · ↓ 48.2k tokens`, no phase text). Enter on that row opens
the workflow's detail view: its phases first (`phase`, `phase_order` and
`phase_detail` are display labels, the title is the model's `phase` verbatim and
agents with the same title are one phase), then the agents of the phase you
open, then one agent's transcript. `x` stops the whole workflow on the phases
and a single agent on the agents; Esc or ← goes back up a level. A workflow
whose agents carry no `phase` label shows one group titled `Agents`.
See [Terminal design](terminal-design.md) for both.

The launch receipt states the facts (the task id, whether it is queued or running, that it has not completed, that its result will arrive as a task notification); the advice to continue other work and to launch each piece once is in the `Agent` description. Completion reaches the model as a task notification. What the agent wrote
reaches the parent in the same marked block every outside text gets (an
`agent-result` block that says whose words these are, and to tell the operator
about any instruction inside it rather than act on it), whether it arrives as a
notification, from a foreground `Agent` call, from `wait_for_task` or from a
saved agent's history; the task id, status and worktree stay outside the block.
A sub-agent has no one to ask: where the working rules say to ask or stop, it
finishes what is safe, leaves the risky step undone and names the blocker or
assumption in its final summary, so the parent decides. `wait_for_task` retrieves
the result without launching duplicate work. `wait_for_task`, `send_message`,
`cancel_agent` and `agent_task_list` reach every agent of the conversation from
any later turn, running or finished: a finished one is returned as it ended
(`wait_for_task` starts no new wait, `cancel_agent` says it already ended) or,
with `send_message`, resumed; a running one keeps the review channel it was
launched under. Background work keeps
the same parent authority, shared tree budget and capacity limit. In the terminal
a background agent outlives the turn that started it and is stopped by you (Ctrl+C
when idle, `ctrl+x ctrl+k`, `x` on its rail row) or by closing the conversation;
a turn that ends or is interrupted does not cancel it. A foreground agent whose
wait you released by typing is treated the same way: it keeps running, and its
end is reported once, like a background agent. If a background agent needs
approval after its turn has ended (to write a file, say), the question appears
on screen under the mode you have now and your answer reaches that agent, whether the conversation is idle or another turn is running (that turn's own questions are kept apart and wait for their own answer); once answered the composer is free again, so the agent's end still wakes the model; only a
stopped turn, another conversation or a closing app refuses it. Foreground agents and
headless hosts keep the original rule: releasing the parent turn cancels the
children it still owns, and a normal parent query waits for them before final
settlement while handling operator input meanwhile.

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

Each row in the agent cockpit and the child transcript header shows the
child's status, elapsed time, description and — when the host reported them —
its resolved model and live counters: cumulative spend compacted to
`42.1k`/`1.38M` and a `N tools` tool-call count, both drawn
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

## Nesting depth

Agents may delegate to agents up to three levels deep (`AgentManagerConfig.maxDepth`). A launch past that is refused to the model with `Max task depth 3 exceeded (current: 3). Do this task yourself with your own tools instead of delegating it to another agent.`, so it finishes the work directly instead of retrying the launch. There is no environment override; the limit is set by the host that builds the manager.

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
whose parent log has no `child_session_ended` yet and whose own log has no
settled turn either is reported as `unresolved`; one whose own log did settle is
reported with that outcome; one that ended carries its actual outcome and a preview of its
answer of at most 16,000 characters, explicitly marked when truncated. A
completed scheduler lifecycle does not turn a token-limited result into
success.

Use `agent_task_list({history: true})` to inspect the snapshot and
`agent_task_list({history: true, task_id: "<UUID>"})` to read one saved result.
The normal tool call still lists live tasks owned by the current session.
A turn that follows earlier delegation is told which agents there were: the
CLI records the listing in the conversation (session id, what each was asked,
status, with the rules for reading it) the first time, then only an agent that
is new or whose status changed. It is a conversation entry, not part of the
system prompt, so it never changes the cached prompt.
Reading the history grants no authority by itself. To continue a saved agent,
`send_message` to its session UUID from `agent_task_list({history: true})`
("Resuming agent …"): its saved history and settings are read back from disk, it
is shown under the short name it was launched with (a plain "Earlier agent" when
the save kept none, never its prompt), a saved model that names no provider is
ignored and any other saved model is checked again before the agent runs, it
runs again under the current turn's limits and review channel, and it appears on
the rail like any resumed agent, with its duration counted from the resume. Only
a finished agent whose saved record is complete can be continued. One that ended
without settling a turn (`unresolved`), one you stopped, one that ran in an
isolated worktree or with a role, one saved by an older version, and one whose
agent type no longer exists answer "Not sent. Agent … was saved by an earlier run
but cannot be resumed …", or the stopped text, and send nothing. `wait_for_task`
and `cancel_agent` take the same UUID once the agent has been resumed.

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

A live monitor transcript keeps at most 120 rows per agent and 2,048 UTF-16 code
units per row field. Its retained previews own their short strings, so a
clipped row does not retain the backing storage of an entire large tool result.
These display bounds do not replace the saved child transcript or bound all
memory used by a running agent.

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

## Direct messages and another task in the same child conversation

In the agent cockpit, open a child transcript and press **Enter** or **m** to
write directly to that child. **Tab** switches between writing and scrolling;
**Esc** returns to the agent list. The parent's draft is kept separately. An
agent opened from the rail is viewed on the main screen instead, where Esc
stops a running agent and goes back from an ended one, and Ctrl+C stops it and
goes back (see [Terminal design](terminal-design.md)).
Messages must be nonblank and at most 16,000 characters. A queued receipt means
acceptance, not proof that the child has read the instruction. A running tool
finishes before the instruction enters the next provider request.

For a finished child still owned by this CLI process, sending opens a **new
TaskId in the same child SessionId**. Previous tasks stay finished. The new
invocation reacquires the current parent conversation, review mode, model
credential, limits and cancellation scope. Its result has an independent,
immutable invocation summary. The transcript keeps its identity and previous
rows, and shows the new task separately. Permission questions still go to the
operator; a direct message does not approve subsequent tool calls.

This continuation is currently available for shared-workspace children only.
An isolated child's resource lease must be explicitly reacquired before reuse,
so direct continuation refuses that case. Saved transcripts after process
restart remain read-only. A transcript on disk does not restore the host's
execution authority, dynamic agent definition or credentials.

The host reports direct operator instructions to the parent as host evidence,
with the instruction quoted, and frames the child's later result as child
output. While the parent is running, notices enter its existing input channel
at a valid request boundary. While idle, they wait for its next turn; they do
not start another parent model call. The host audit is stored in
`<parent-session-dir>/child-operator-messages.jsonl`. A bounded reader restores
unacknowledged observations after restart and acknowledges only the context
snapshot used by a parent response ending with `end_turn`. A timeout, budget
stop or other unsuccessful finish keeps the notices pending for retry, including
a stop before any model request. Audit history grants no tool
permissions and never restarts a child.

The process retains at most eight parent runtime scopes; idle scopes are
eligible for eviction. Direct continuation also requires a retained child view
and the exact original registered definition. An evicted or replayed view is
refused. Independent terminals use the separate local peer transport described
in [Messages between live terminals](peer-messaging.md); it is not the owned-child mailbox.
