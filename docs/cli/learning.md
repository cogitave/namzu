---
type: Reference
title: Learning in the CLI
description: namzu learn and namzu learning, the observations ordinary conversations keep when something fails, the built-in generator that learns from them by itself, what is stored and where, how long, and the learningObservations and learningGenerator keys that turn them off.
resource: packages/cli/src/commands/learn.ts
tags: [cli, learning, observations, config]
status: draft
generated: { by: process:claude-code, at: 2026-10-26T00:00:00Z }
---

# Learning in the CLI

Learning is not tied to residents. Two commands are the front door, and an
ordinary conversation, in the terminal or through `namzu exec`, feeds it.

## Commands

```text
namzu learn [--cwd <path>]
namzu learn --list [--cwd <path>]
namzu learn --undo [cycle-id] [--cwd <path>]
namzu learn <experiment.learning.js> [--trust] [--cwd <path>] [--agent <name>]
namzu learn --sessions <experiment.learning.js> [--trust] [--cwd <path>]
namzu learning [cycle-id] [--events] [--after <n>] [--before <n>] [--limit <n>]
namzu learning --observations [--after <n>] [--limit <n>]
namzu learning --sessions [--after <n>] [--limit <n>]
```

`namzu learn` with no module runs one cycle of Namzu's own generator now (see
[Learning by itself](#learning-by-itself)); `--list` and `--undo` show and
revert what it learned. With a module, `namzu learn` runs one experiment from a
host module you chose, through the SDK's [learning cycle](../sdk/learning.md).
The module supplies the generator and the independent evaluation, it runs only
with `--trust`, and the result becomes active only for the exact revision that
passed. `namzu learning` lists experiments, shows one, or lists observations.
`--observations` lists a resident's; `--sessions` lists what conversations in
the folder kept (below) and needs no resident. It only reads.

`namzu resident learn` and `namzu resident learning` are the same commands under
their older names and behave identically. The experiment's activation target is
still an agent's saved guidance, so both need an agent in the folder
(`--agent`, default `default`); without one, `namzu learn` says so and stops
(`--sessions` needs none, below); see [Resident work](resident-work.md#explicit-learning-experiments).

## What a conversation keeps

When a conversation sees one of these, it writes an observation:

- a tool call that failed (not one you declined or cancelled),
- a provider error or a failed turn,
- a turn that paused or stopped before it finished,
- a recovery: the provider failed a request and the turn asked again, a reply
  moved to the next provider in the chain, the conversation history was
  repaired before a model call, or a compaction pass failed and left the
  history unchanged. These use fixed wording and never copy the event's text.

An observation holds a reference to the conversation and turn, the kind of
failure, the time it was recorded, and one fixed sentence naming the tool,
stop reason or provider error code. The failure message itself is never kept,
because free text cannot be masked reliably. Only failures count: a turn that
hit a limit, timed out, was refused or errored. Your own cancel, a rejected
plan, a stop you asked for, a plain approval pause and successful turns record
nothing. It never holds your prompt, the model's answer or a tool's output;
the details stay in the conversation's own log, which the reference points to.
Each is marked usage-incomplete, so none can start an
experiment by itself. Successful turns record nothing.

Observations are kept under the project's state directory
(`projects/<project>/learning/`), never uploaded, and dropped once they are
older than 30 days, judged by the recorded time. The check runs when a
conversation writes its first observation, so a folder nobody works in again
keeps its last observations until someone does. Experiments never lose an
observation they have claimed. Read them with `namzu learning --sessions`.

Turn recording off with `learningObservations: false` in the user or project
config. Absent means on. Ephemeral conversations (`exec` without a
conversation) keep nothing.

## Learning from conversations, with no resident

`namzu learn --sessions <module>` starts from the observations conversations in
this folder kept, with no agent needed. The module is the same kind of host
module and runs only with `--trust`; the independent two-round check and the
confirmation are unchanged, and only the exact revision that passed is
activated. The result is this project's own guidance (the evaluated skills,
stored with their history under `projects/<project>/learning/guidance/`), not
an agent's. If no conversation here has kept an observation yet, it says so
and stops with exit 64.

Every later conversation in the folder starts with that guidance in its
context, as advice about how to work here: it grants no permission and runs
nothing. Ephemeral conversations do not read it. An exploration policy is never
handed to a conversation. Revert by activating an earlier revision through the
same history, as for a resident.

## Learning by itself

Namzu writes what it learns about working in a folder the way it writes notes
to memory: in the background, without a command. It is on unless you turn it off
with `learningGenerator: false` (below). It runs in the interactive terminal,
never in `exec`, a scheduled run or a sub-agent, and only for conversations that
keep observations.

**When it starts.** After a turn ends and no turn is open, Namzu checks the
folder's kept observations. A cycle starts when at least 5 new ones have
accumulated since the last cycle, at least 6 hours have passed since the last
cycle started, and today's token allowance is not used up. The check runs at
most every 10 minutes. Every model call waits for an idle conversation, so a
cycle never competes with your own turn, and closing the session stops it.
Only one cycle runs per folder at a time.

**What it does.** One cycle makes one revision of the folder's guidance
(an instruction skill named `session-guidance`; nothing else is editable, and
permission review, protected paths, the always-refused command patterns and the
learning code are never part of what it may change). The model reads the kept
observations (their fixed one-sentence descriptions, never the failure text),
the guidance now in force, and what earlier cycles in this folder tried and how
they ended. A revision that reaches outside the editable surface, or whose
wording would weaken the safety floor or tell you to start over, is sent back
once and then refused.

**How it is checked.** The revision never grades itself. A built-in evaluation
runs fixed scenarios under the current guidance and under the revision: three
about recovering from trouble and two plain tasks that must not get worse in
each of two rounds, five tasks per round, two trials per task, with different
tasks in the second round. Each trial is graded by a separate model call that
sees the rubric and both replies in an order it cannot tie to a side. The
revision is activated, for exactly that revision, only when it improves at least
one task in both rounds, regresses none, and keeps the plain tasks passing. Most
cycles end `rejected` or `inconclusive`; that is the gate working, not an error.
The generator never sees the scenarios, and a revision that repeats one is
refused as a leak. Every outcome, including a rejected revision and what was
tried, is kept in the folder's learning history and informs the next proposal.

**What it costs.** Which model: the configured `smallModel`, else the cheapest
text model of the active provider, else the conversation's own model; the
provider you configured, nothing else. A full cycle makes about 60 model calls,
mostly short. One cycle stops at 120,000 recorded tokens and all cycles together
at 300,000 tokens per local day; a call whose usage cannot be measured ends the
cycle as inconclusive instead of counting as free. `namzu learn` runs the same
cycle on request and keeps the daily limit.

**What you see.** When a cycle activates a revision, one dim row appears in
the conversation, once: `Namzu learned something for this folder: <one line>
Undo with \`namzu learn --undo\`.` A cycle that is rejected or inconclusive
changes nothing and shows nothing. Activation needs no confirmation, because
the editable surface is guidance text only and every activation is kept by its
exact revision, so `namzu learn --undo` always restores the one before. Anything
off that surface is refused and never activated. The model can also save a
durable lesson itself during a turn with its memory tool (`save_memory`),
without being asked.

**Where it is kept and how to undo it.** The guidance and its history are in the
folder's `learning/guidance` state, the observations and the cycle journal in
`learning/`, the experience library in `learning/experience.sqlite`, and the
pause and today's spend in `learning/generator.json`; all stay on this machine.
`namzu learn --list` shows each activation and which one is active, and
`namzu learn --undo` restores the guidance the newest active revision replaced
(or a given cycle, if it is still the active one). An undo is a new revision, so
it appears in the history. The guidance is advice, never a permission and never
an instruction to run anything.

### The `learningGenerator` key

```yaml
learningGenerator: false          # turn learning by itself off
learningGenerator:
  enabled: true
  cycleTokens: 120000             # one cycle (1,000 to 10,000,000)
  dailyTokens: 300000             # all cycles in one local day
```

Absent means on with these defaults. A project file can turn learning off and
lower a cap, never turn it back on or raise a cap. It is not settable from the
environment. `namzu learn` with no module still runs a cycle by hand when this
is `false`.

## What is not done yet

The built-in generator proposes one revision of one guidance skill. It does
not run several candidates at once, compose them, or choose between them blind.
The evaluation's scenarios are fixed and general (recovering from trouble and
plain tasks), so guidance specific to a project's own work is checked only for
doing no harm and for the recovery behaviour. Nothing else Namzu owns (tools,
hooks, agents, configuration) can be edited by learning.
