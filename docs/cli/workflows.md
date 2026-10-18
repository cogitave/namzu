---
type: HowTo
title: Workflows in the CLI
description: The workflow tool: when the model is offered it, the review before it starts, how its agents run and appear, how to stop or skip, and what the model is told when it ends.
resource: packages/cli/src/integrations/workflows
tags: [cli, workflows, orchestration, agents]
status: stable
generated:
  by: claude-sonnet-5-5
  at: 2026-10-18
---

# Workflows in the CLI

A **workflow** is one background run of a script the model writes once. The
script decides how many agents run, with which prompts, in which order and
under which phase titles; Namzu schedules them. A **subagent** is what the
`Agent` tool starts: the model decides each one, turn by turn. The two stay
apart on screen and in the code. The engine is documented in
[Workflows (SDK)](../sdk/workflows.md); the decision and its trust model are in
`packages/sdk/src/agents/AGENTS.md`.

Use the `Agent` tool for one subagent or a small fan-out. Use a workflow when
the work has several phases or more agents than the model should orchestrate
by hand.

## When the model can start one

The `workflow` tool is not in the tool list on an ordinary turn. It is offered
for a turn when the operator asked for orchestration:

- hypermode is on (`/hypermode`), or
- the message says `workflow` or `workflows` in any case, or `iş akışı` in
  Turkish (with or without the diacritics), or
- the message is `/workflow <what to do>`, which sends `Use a workflow for
  this: <what to do>`.

It is offered for that turn only; the next message gets the tool back only if
it asks again (or hypermode is on). A scheduled or resident run never gets it.
When the tool is offered, the model is also told to prefer it for multi-phase
or many-agent work and to keep `Agent` calls with a `workflow` label for small
fan-outs.

## The review

Starting a workflow is reviewed like a destructive call, before anything runs.
The screen shows, in order:

```text
╭──────────────────────────────────────────────────────────────────────────────╮
│ Start a workflow                                                             │
│   Workflow: denetim                                                          │
│   Purpose: Paketleri tara, sonra duzelt                                      │
│   Phases:                                                                    │
│     1. Tarama                                                                │
│     2. Duzeltme — yalnizca guvenli duzeltmeler                               │
│   Agents: up to 8 at a time, 200 in all, each with the same tools and        │
│   approval rules as an Agent call                                            │
│   Runs in the background; you can stop it from the rail or /workflows        │
│   Script · 14 lines                                                          │
│     export const meta = { name: 'denetim', … }                               │
│     … (first 8 lines)                                                        │
│     … 6 more lines                                                           │
│                                                                              │
│ Do you want to start this workflow?                                          │
│ ❯ 1. Start this workflow                                                     │
│   2. Start and allow all tools for this conversation                         │
│   3. Do not start                                                            │
│ ↑↓ select · enter confirm · y / a / n answer · esc decline · d script        │
╰──────────────────────────────────────────────────────────────────────────────╯
```

The name, purpose and phases are read from the script's `meta` literal
without running anything. `d` shows the whole script, every line verbatim;
`d` again collapses it; the full view scrolls with PgUp, PgDn, Home and End.
The script may be as large as the runtime accepts (256 KiB, with `args` up to
64 KiB): the 8 000-byte limit that refuses an oversized batch of ordinary tool
calls does not apply to a workflow review, because the script is one bounded
value read in a pager. Long `args` are clipped in the collapsed view and whole
under `d`. A script whose `meta` cannot be read is still shown, with the reason.

| Situation | What happens |
|---|---|
| `prompt` or `accept-edits` mode with a person at the terminal | the review above |
| `auto` mode (`--dangerously-skip-permissions`, "bypass permissions on") | it starts without asking, like any other call |
| `plan` or `strict` mode | refused by the mode, as any change is |
| no one to ask (`exec`, `exec --json`) and not `auto` | refused, in words the model can pass on, naming `--permission-mode auto` |

Answering `Do not start` is the person's own No: the model is told it was
declined and the transcript shows `○ Workflow(…)` and `You declined this, so it
did not run.`

## What it can and cannot do

The script is untrusted model input, like a `bash` command line. It runs in the
confined interpreter behind `run_code`: no files, network, commands, timers or
imports. Its only capability is `agent()`, and each agent it starts goes through
the same delegation path as the `Agent` tool: the session's permission mode and
rules, the same sandbox, the same tool rosters for `general-purpose` and
`explore` and project agents, the same token budget and cancellation. A prompt
the script passes is data; it cannot widen a grant.

A workflow's agents ask their questions through the review channel of the turn
that started the workflow, but for as long as the workflow runs, not only for as
long as that turn does: an approval for an agent's `edit` appears on screen even
when the model's turn is over, under the permission mode the operator has chosen
at that moment. Leaving the conversation (`/resume`, `/new`) stops running
workflows.

Limits come from the configuration below, or the SDK defaults: at most `min(8, CPUs − 2)` agents run at
once, 200 start per run, one value crossing the bridge is at most 1 MiB, and the
turn's token budget (when one is set) stops new agents once it is spent. A script
that asks for more fails with a plain reason.

## What the person sees

At launch the transcript gets two lines, and the model's own receipt (the run
id, how it will hear back) is never shown:

```text
● Workflow(Paketleri tara, sonra duzelt)
⎿ Running in the background (↓ to manage)
```

The agents rail gets **one row** for the run, after any subagent rows:

```text
  ◯ denetim  ▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱  3/6 · 12s · ↓ 30 tokens
```

The count is the agents that **completed** over every agent the script has asked
for so far, queued ones included; a skipped, failed or stopped agent does not
fill the bar. A stopped run's bar stays where it was, and only the bullet and the
detail header (`· stopped`) say how it ended. Phases are not on the row. The bullet is coloured only
by outcome. The row leaves 30 seconds after the run ends. A workflow's agents
are never subagent rows, are not counted in the turn's `✻ Worked for …` line,
and write no launch or completion rows of their own.

↓ from the composer reaches the row (`enter to view · x to stop`). Enter opens
the detail, which shows one list at a time:

1. **Phases**: the number (turning `✔` or `✘`), the title, and `done/total`.
   Phases the script declared in `meta.phases` are listed from the start in the
   declared order; one nothing has started in is dim, with no count. Esc goes
   back to the row. `x` stops the whole run: queued agents never start, running
   ones are cancelled.
2. **`<phase> · N agents`**: each agent as `✔` done, `✘` failed or skipped, `●`
   running or `◌` queued, with its label, type, model, tokens and time. A phase
   nothing has started in says `Not started yet`. `x` skips the selected agent:
   a queued one never starts, a running one is cancelled, and its `agent()`
   gives the script `null`.
3. **The agent's transcript**: its own, like any child's, headed by the workflow
   and the phase (`denetim · Tarama`) and the agent's label rather than
   "Subagent". Workflow agents cannot be messaged from here.

A skipped agent does not fail its phase. The header reads `denetim  <purpose>
3/6 agents · 12s` and, once the run has ended, ends with `· completed`,
`· failed` or `· stopped`.

## When it ends

The conversation gets one line when the **run** ends, whatever the model is
doing, not when a turn ends:

```text
✓ Workflow denetim completed · 13s · 6 agents · 75 tokens
✗ Workflow denetim failed · 4s · 3 agents · 1 failed
■ Workflow denetim stopped · 8s · 5 agents
```

The model gets one message about it. Inside a turn that is running, it arrives
when the turn next asks for input. When the session is idle, it **wakes the
model**: a turn starts at once, carrying that message, and the model reports on
the run without the person typing anything (two runs that end together share one
turn). The message carries the status or the failure reason, the agents that
failed and why, the usage, and the script's return value capped at 8000
characters, wrapped as untrusted material because it was assembled from
subagents' answers. Each is delivered once. A background command that ends on
its own wakes the model the same way (see [Background jobs](background-jobs.md));
one you stopped yourself does not.

## `namzu exec`

A headless run does not end with the model's first turn while a workflow it
started is going. `exec` (and `exec --json`) waits for the run, bounded by the
run's own limits and by the turn limit (`limits.timeoutMs`) when one is set, at
which point whatever is still going is stopped and reported as stopped. It then
gives the model the one message above, lets it take a reporting turn, and only
then closes the session. The text printed (or the final `done`) is the report
turn's. A first turn that failed or paused is not waited on. Nobody is there to
review the script, so a headless run may start a workflow only in `auto` mode
(`--dangerously-skip-permissions`, the headless default); in `prompt`,
`accept-edits`, `strict` and `plan` the model is told why it was refused.

## `/workflows`

`/workflows` lists this conversation's runs, newest first, with status, agents
settled over asked, tokens, how long ago it began and how long it took. Enter
opens the same detail. Runs started in this process come from the live registry;
earlier ones are read from their journals. A run whose process ended before it
finished is listed as stopped.

## Where a run is kept

Each run writes an audit trail under the conversation:
`<session>/runs/<runId>/workflow/script.js` (the exact script, mode 0600) and
`journal.jsonl` (the declared `meta`, `args`, every `agent()` request with a
prompt preview and hash, every outcome, phases, `log()` lines and the result).
Run ids are `w` and eight base-36 characters. Each agent also keeps its normal
child transcript under `<session>/subagents/`.

## Configuration

```json
{ "workflow": { "maxConcurrency": 4, "maxAgents": 300 } }
```

in `namzu.config.json` or `~/.namzu/config.yaml`. `maxConcurrency` is how many of a
run's agents go at once: a whole number from 1 to 16, default `min(8, CPUs − 2)` and
at least 1. `maxAgents` is how many agents one run may start: 1 to 1000, default 200.
Both are optional, are refused with the file and key named when out of range or not
whole numbers, and are never read from the environment. The review shows the values
in force ("Agents: up to 4 at a time, 300 in all"). The turn's token budget
([Turn limits](turn-limits.md)) also stops a run from starting agents once it is spent.

## Skipping and stopping under a token budget

Stopping a run or skipping an agent cancels a model request that may not have reported its usage. That request is closed on an estimate (the prompt plus what had streamed) instead of being left as unknown spend, so the rest of the turn's budget stays available to the other agents; the estimate can undercount what the provider billed for the unreported part. A request that failed for any other reason, or whose delegation runtime was closed under it, keeps its unknown-spend marker as before.

## Three choices worth knowing

- In `auto` mode ("bypass permissions on") a workflow starts without a review, like any other call.
- A run has its own token ledger, apart from the turn's: its agents share the turn's budget limit but are counted on the run.
- An agent's `schema` option is carried as an instruction in its prompt, and the reply is parsed and validated against the schema; a reply that does not match makes that agent's `agent()` give `null`.

## Not in this version

Named or saved workflows, resuming a run from its journal, nested `workflow()`,
worktree isolation per agent, and a pause key.
