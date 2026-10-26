---
type: Reference
title: Learning in the CLI
description: namzu learn and namzu learning, the observations ordinary conversations keep when something fails, what is stored and where, how long, and the learningObservations key that turns it off.
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
namzu learn <experiment.learning.js> [--trust] [--cwd <path>] [--agent <name>]
namzu learn --sessions <experiment.learning.js> [--trust] [--cwd <path>]
namzu learning [cycle-id] [--events] [--after <n>] [--before <n>] [--limit <n>]
namzu learning --observations [--after <n>] [--limit <n>]
namzu learning --sessions [--after <n>] [--limit <n>]
```

`namzu learn` runs one experiment from a host module you chose, through the SDK's
[learning cycle](../sdk/learning.md). The module supplies the generator and the
independent evaluation. Nothing runs in the background, the module runs only
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
- a turn that paused or stopped before it finished.

An observation holds a reference to the conversation and turn, the kind of
failure, the time it was recorded, and one short excerpt (at most 160
characters) of the failure message with home folders, absolute paths, links,
email addresses, `key=value` secrets, bearer credentials and long token-like
strings masked. The excerpt can still contain other words from the message, so
it is not a guarantee that nothing sensitive survives. It never holds your
prompt, the model's answer or a tool's output; the details stay in the
conversation's own log, which the reference points to. Each is marked usage-incomplete, so none can start an
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

## What is not done yet

The generator is not built in: Namzu supplies none of its own and activation
needs a module you wrote. Nothing starts `namzu learn --sessions` by itself;
you run it.
