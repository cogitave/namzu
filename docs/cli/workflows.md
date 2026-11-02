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

The `workflow` tool is in the tool list on every turn of a terminal or `exec`
run that can run one, and the model is gated by wording, not by the list: the
tool's text and a stable note in the system prompt say it may be called only
after an explicit opt-in (the list does not change from message to
message, which keeps the cached prompt prefix stable). The opt-in is the operator asking for orchestration:

- hypermode is on (`/hypermode`), or
- the message arms the `workflow` composer trigger: `workflow` or `workflows`
   as the first or last word of a clause, matched by
  the same rules as `hypermode`. The composer shows a tag
  (`Workflow · this turn, opts into the workflow tool · alt+w drop`) before you
  send, and Alt+W drops it. A question about workflows ("how does the build
  workflow cache work?") only suggests it, and `composerTriggers` can turn it
  off ([Composer triggers](composer-triggers.md)).

Each agent a workflow starts is told in its prompt that its step is its
assigned job, which the person approved with the script, so a note elsewhere
that a message carries no user authority is not a reason to skip it.

The keyword and the `workflow` trigger opt in one message only;
the next message needs to ask again unless hypermode is on. Hypermode, named on
the composer's upper rule while on, is a
standing opt-in: the model is told so in a hidden reminder kept in the conversation (full the
first time, sparsely after ten of your messages, once when it ends; a resumed
conversation reads what was already said from its history and does not hear the
full text again), to use the tool for every
substantial task and to work alone only on conversational or trivial turns. A
scheduled run has no one to review a script and no `workflow` tool; with the
`hypermode` config key on it is told to delegate to parallel agents instead, and
a resident run is told nothing. The tool text carries the quality patterns
(adversarial verify, judge panel, loop until dry, completeness critic) and
keeps `Agent` calls with a `workflow` label for small fan-outs.

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
│   Agents: up to 16 at a time, 1000 in all, each with the same tools and      │
│   approval rules as an Agent call                                            │
│   Runs in the background; you can stop it from the rail or /workflows        │
│   Script · 14 lines                                                          │
│     export const meta = { name: 'denetim', … }                               │
│     … (first 8 lines)                                                        │
│     … 6 more lines                                                           │
│                                                                              │
│ Do you want to start this workflow?                                          │
│ ❯ 1. Start this workflow                                                     │
│   2. Do not start                                                            │
│ ↑↓ select · enter confirm · y / n answer · esc cancel · d script             │
╰──────────────────────────────────────────────────────────────────────────────╯
```

The name, purpose and phases are read from the script's `meta` literal
without running anything. The review shows the script's first lines, however
short the script is; `d` ("d read the whole script") shows every line of it
verbatim under the heading "Workflow script", never the raw prepared input;
`d` again collapses it; the full view scrolls with PgUp, PgDn, Home and End.
The script may be as large as the runtime accepts (256 KiB, with `args` up to
64 KiB): the 200 thousand character limit that withholds a large value of an
ordinary tool call does not apply to a workflow review, because the script is
one bounded value read in a pager. Long `args` are clipped in the collapsed view and whole
under `d`. A script whose `meta` cannot be read is still shown, with the reason.

| Situation | What happens |
|---|---|
| `prompt`, `accept-edits` or `auto` mode with a person at the terminal | the review above |
| `bypass` mode (`--yolo`, `--dangerously-skip-permissions`, "bypass permissions on") | it starts without asking, like any other call |
| `plan` or `strict` mode | refused by the mode, as any change is |
| no one to ask (`exec`, `exec --json`) and not `bypass` | refused, in words the model can pass on, naming `--permission-mode bypass` |

Answering `Do not start` is the person's own No: the model is told it was
declined and the transcript shows `○ Workflow(…)` and `You declined this, so it
did not run.`

## What it can and cannot do

The script is untrusted model input, like a `bash` command line. It runs in the
confined interpreter behind `run_code`: no files, network, commands, timers or
imports. Its only capability is `agent()`, and each agent it starts goes through
the same delegation path as the `Agent` tool: the session's permission mode and
rules, the same sandbox, the same tool rosters for `general-purpose`,
`explore`, `plan` and project agents, the same token budget and cancellation. A prompt
the script passes is data; it cannot widen a grant.

A workflow's agents ask their questions through the review channel of the turn
that started the workflow, but for as long as the workflow runs, not only for as
long as that turn does: an approval for an agent's `edit` appears on screen even
when the model's turn is over, under the permission mode the operator has chosen
at that moment. Leaving the conversation (`/resume`, `/new`) stops running
workflows.

Limits come from the configuration below, or the SDK defaults: at most `min(16, CPUs − 2)` agents (at least 2) run at
once, 1000 start per run, one value crossing the bridge is at most 1 MiB, and the
turn's token budget (when one is set) stops new agents once it is spent. A script
that asks for more fails with a plain reason.

## When the call answers

The `workflow` call does not return the moment the run is created. It waits for
one of three events of the run itself (never a timer), and answers on the first:

- **The script asks for its first `agent()`.** The run is real work now; the call
  returns the launch receipt and the run goes on in the background, as below.
- **The script fails before that.** The call is a **failed tool call** carrying the
  located message. The conversation row shows `✘` and the first line of that
  message as the script printed it, in the error colour, under the call; the
  rest (the line's text, the phase, the hint about a missing `args`) is not
  shown and there is nothing to expand. The model gets the whole message unchanged. There is
  no rail row, no launch line and no completion message afterwards. The hint
  appears when the call passed no `args` and the error mentions `args`, because
  `args` is exactly the object given in the call's `args` field and is
  `undefined` when it is omitted.
- **The script finishes without asking for an agent.** The call returns the same
  summary the completion message carries, inline, and no message follows.

If the person interrupts the turn while the call waits, it lets go and the run
(if any) continues in the background.

`wait_for_task` is for tasks that `Agent` launched. Given a workflow run id (`w`
and eight letters or digits) it answers in words that a workflow run is not a task
and that its end arrives as one message, so the model ends its turn or does other
work. It does not wait for the run: the completion message is the only delivery,
and it is never delivered twice.

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
by outcome. The row leaves 30 seconds after the run ends; a run that ended without ever asking for an agent has no bar to show and leaves at once. A workflow's agents
are never subagent rows, are not counted in the turn's `✻ Worked for …` line,
and write no launch or completion rows of their own.

↓ from the composer reaches the row (`Enter to view · x to stop`, shown in place of the footer's mode line). Enter opens
the detail, a frameless dialog (side by side from 64 columns, one list at a time below):

1. **Phases**: the number (turning `✔` or `✘`), the title, and `done/total`.
   Phases the script declared in `meta.phases` are listed from the start in the
   declared order; one nothing has started in is dim, with no count. Esc goes
   back to the row. `x` stops the whole run: queued agents never start, running
   ones are cancelled.
   A phase whose agents were all skipped shows `✘`, not the tick: the tick is
   for a phase where something finished. The phase's detail text (from
   `meta.phases`) sits right under its title in the right-hand pane. The last
   `log()` line the script wrote shows under the header, the two before it dim;
   the rail row never shows them.
2. **`<phase> · N agents · D done`**: each agent as `✔` done, `✘` failed or skipped, `●`
   running or `◌` queued, with its label, type, model, tokens and time. A phase
   nothing has started in says `Not started yet`. `x` skips the selected agent:
   a queued one never starts, a running one is cancelled, and its `agent()`
   gives the script `null`.
3. **The agent's transcript**: its own, like any child's, headed by the workflow
   and the phase (`denetim · Tarama`) and the agent's label rather than
   "Subagent". Workflow agents cannot be messaged from here.

A skipped agent does not fail its phase, and a run in the footer counts as
`1 workflow`, never as an agent (`← 2 agents · 1 workflow`). The header reads `denetim  <purpose>
3/6 agents · 12s` and, once the run has ended, ends with `· completed`,
`· failed` or `· stopped`. Each place counts the agents the way it needs to,
and a failure is never folded into the count (only an agent that completed is done; a failed or stopped one is not): the rail row and the header read
`done/total` (`3/7 · 2m 14s`, `2/3 agents`), the `/workflows` list reads
`done/total agents` whether or not the run is whole, and the closing line reads
the total only (`3 agents`). A failed run shows in the rail row's red bullet, in
the status word, in the phase list, where `· N failed` follows a phase's
`done/total` in the error colour (`2/3 · 1 failed`), and in the phase's agent
list, where it follows the `· D done` count the same way
(`Scan · 3 agents · 2 done · 1 failed`).
A step
that throws before it asks for an agent (inside `parallel()` or `pipeline()`) is
not an agent: it shows as the progress line `Step 2 stopped: <why>` and is
listed for the model among the failures.

## When it ends

The conversation gets one line when the **run** ends, whatever the model is
doing, not when a turn ends:

```text
✓ Workflow denetim completed · 13s · 6 agents · 75 tokens
✗ Workflow denetim failed · 4s · 3 agents
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

While a run is going the model also gets a short note each time it moves to a later phase (see [Notes the host sends without being asked](delegated-work.md#notes-the-host-sends-without-being-asked)). The note rides with the next request and never starts a turn by itself. When the person asks how the run is going, the model reads its state (`agent_task_list` with `run_id`, or the running-work note), reports its phase and counts, and says it is still running until the completion message arrives.

## `namzu exec`

A headless run does not end with the model's first turn while a workflow it
started is going. `exec` (and `exec --json`) waits for the run, bounded by the
run's own limits and by the turn limit (`limits.timeoutMs`) when one is set, at
which point whatever is still going is stopped and reported as stopped. It then
gives the model the one message above, lets it take a reporting turn, and only
then closes the session. The text printed (or the final `done`) is the report
turn's. The `Tokens:` line on stderr (and `budget` in `exec --json`) is what the whole command spent: the first turn plus the reporting turn for `own`, and for `including descendants` also the workflow's agents, which are counted on the run and not on the turn. A first turn that failed or paused is not waited on. Nobody is there to
review the script, so a headless run may start a workflow only in `bypass` mode
(`--yolo`, `--dangerously-skip-permissions`) or the unattended default; in `prompt`,
`accept-edits`, `auto`, `strict` and `plan` the model is told why it was refused.

## `/workflows`

`/workflows` lists this conversation's runs, newest first, with status, agents
settled over asked, tokens, how long ago it began and how long it took. Enter
opens the same detail; the footer reads `enter to view · x to stop · esc to
close` (`x` only on a run that is still going, and it stops that run; `r` on a run that is not going asks the model to resume it, see [Resuming a run](#resuming-a-run)), under a
subtitle such as `1 running, 2 finished`, in a rounded frame; each row reads the transcript's words (`finished`, `failed`, `stopped`) and puts the duration right after, so a narrow screen drops the tail and never half a number. Runs started in this process come from the live registry;
earlier ones are read from their journals. A run whose process ended before it
finished is listed as stopped. A run that was resumed shows the pass it is on and how many of its agents returned saved results.

## Where a run is kept

Each run writes an audit trail under the conversation:
`<session>/runs/<runId>/workflow/script.js` (the exact script, mode 0600) and
`journal.jsonl` (the declared `meta`, `args`, every `agent()` request with a
prompt preview and hash, every outcome with the agent's full result, phases,
`log()` lines and the result). A resumed pass adds `script.<n>.js`. Every line is
numbered and chained to the one before it, and signed with a secret kept in
`~/.namzu/workflow-journal.key` (made on first use, mode 0600). Run ids are `w`
and eight base-36 characters. Each agent also keeps its normal child transcript
under `<session>/subagents/`, named in the journal as `childSessionId`.

The model edits a copy of the script, not the original:
`<session>/workflows/scripts/<name>-<runId>.js` (mode 0600, written when the run
starts and named in the receipt). `scriptPath` reads only files in that folder,
and only regular files with a single name (no link), at most 256 KiB, fresh on
every call.

## Resuming a run

The `workflow` tool takes two more inputs. `scriptPath` is a saved script to run
instead of sending `script` again (`script` wins when both are given).
`resumeFromRunId` continues an earlier run of this conversation under its own
id: the same journal grows by one pass and `/workflows` still shows one run.
Agents whose prompt and options are unchanged return the result the journal
saved, without starting anything; the first call that is new, was edited, failed
or was skipped starts running again, and so does everything after it. A call
that was cut off by a stop or a closed session runs again without ending reuse.
Resuming a finished run is allowed (every unchanged call replays), and resumes
compound. Nothing resumes by itself.

A resume goes through the same review as a start. It also shows which run it
continues and what it can reuse:

```
Resumes run w1ab2cd3 (pass 3; the previous pass did not finish)
  About 6 agents return saved results and are not run again; the rest run live.
  Script: unchanged since the run started
```

The saved-results figure is "about" when the script is unchanged; for an edited
script the review says "up to" and that edited and later calls run. The review
never states how many agents will run live, because the script may make calls the
earlier pass never reached. A journal that was
changed or cut short is named by line and its later results run again.

A run that is still going, or is stopping and whose agents have not exited,
cannot be resumed (the tool says so). A run saved before resuming existed
(its journal has no chain) cannot be resumed and the tool says to run it again.

**Scripts must be deterministic.** In a workflow script `Date.now()`, `new Date()`
with no argument and `Math.random()` throw, with a message that says to pass a
timestamp through `args` or to put an index in the label or prompt; `new Date(x)`,
`Date.parse` and `Date.UTC` still work, and `eval` is not available. A script that
made different calls on a rerun could not safely reuse results.

**Runs a closed session left unfinished.** When a conversation is opened again,
any run in it whose journal never recorded an end is marked stopped, named to you
in one line, and told to the model once with its next turn (it never wakes an idle
model): how many agents had saved results, how many had not finished, and the
`workflow({scriptPath, resumeFromRunId})` call that picks it up. The notice is
kept on disk until a turn has delivered it, so quitting before then does not lose
it. It is told once per pass: if you resume the run and that pass is cut off too,
the new pass is announced again, and a notice for a pass you have since resumed is
dropped. More than 20 such runs are announced as one message that names 20 of
them; the others are told with the next turn. A run whose journal was signed with
a different key than this machine has now (the key file was replaced or cannot be
read) is named with that reason, since none of its results can be trusted. Runs you
stopped, runs that ended and runs of other conversations are not announced.

**Integrity.** The chain and the signature find a journal that was damaged,
edited, reordered or cut short; a record that fails the check is not used, and the
agents behind it run again. They do not protect against someone who can both
rewrite the whole journal and read the key file, and they assume one Namzu process
works in a conversation at a time. The key lives outside the folders the file-editing
tools write in, but Namzu runs on your machine by default, so a shell command the
model runs can read it like any other file of yours: the signature catches damage
and edits made with the file tools, not a hostile shell.

**What is reviewed is what runs.** When a resume or a start names a saved script by
`scriptPath`, the review shows the file's text at that moment and remembers its hash.
If the file reads differently when the run starts (something wrote it after you
approved), the run is refused and the model is told to call again so the current
text is reviewed. An approval you gave once is never carried to a different text.

The model can inspect a running workflow's children with
`agent_task_list`; a selected `task_id` with `include_output: true` returns
bounded partial activity without waiting. Workflow children retain the same
conversation ownership for lookup, messaging, waiting and cancellation as
ordinary children. The [outstanding-work note](delegated-work.md#the-outstanding-work-note)
reports each active run on every model request, with its phase, its running,
queued and done counts and whether it is progressing, waiting or stalled; it is
refreshed for each request and is not a completion notification.
`agent_task_list` with `run_id` reads one run, ended or not: phase, counts, the
last `log()` lines, previews of what finished agents answered (marked as data)
and elapsed time, never an estimate of the end. The launch receipt allows one
such read when the person asks how it is going and still forbids polling in a
loop.

This journal is an audit trail, not an execution checkpoint: prompt and result
previews are truncated, and full schemas/results and a stable logical call
identity are not retained. Stopping a workflow ends its interpreter. Running
the script again starts new work and can repeat already completed steps;
continuing one child would not restart the workflow's orchestration.

## Configuration

```json
{ "workflow": { "maxConcurrency": 4, "maxAgents": 300, "sizeGuideline": "medium" } }
```

in `namzu.config.json` or `~/.namzu/config.yaml`. `maxConcurrency` is how many of a
run's agents go at once: a whole number from 1 to 16, default `min(16, CPUs − 2)` and
at least 2. `maxAgents` is how many agents one run may start: 1 to 1000, default 1000.
`sizeGuideline` is how big a workflow the model is advised to write (see below). All are optional, are refused with the file and key named when out of range or not
whole numbers, and are never read from the environment. The review shows the values
in force ("Agents: up to 4 at a time, 300 in all"). The turn's token budget
([Turn limits](turn-limits.md)) also stops a run from starting agents once it is spent.

### Size guideline and the large-run warning

`sizeGuideline` is `small` (fewer than 5 agents), `medium` (fewer than 10, the
default), `large` (fewer than 50) or `unrestricted`. Except for `unrestricted`
it adds one paragraph to the system prompt, right after the workflow rules, saying
so (the `workflow` tool's description does not carry it, so changing the setting never
rewrites the tool definitions); it is advice, never a limit, and the paragraph is fixed
when the session starts. A
running workflow that schedules more than 25 agents (or the guideline's count,
when you set one), spends more than 1.5 million tokens, or is on course to (the
average of the agents that started, or 70 000 each before any has, times the
agents scheduled) gets `Large workflow · /workflows to stop` on its rail row,
shortened to `Large workflow` when the row is narrow. It does not appear while
hypermode is on. `NAMZU_WORKFLOW_SIZE_WARNING_AGENTS` and
`NAMZU_WORKFLOW_SIZE_WARNING_TOKENS` override the two thresholds.

### Token target

A standalone `+500k`, `+1.5m` or `+2b` in a message you type is the token target
for that turn (the last one wins; text the model or a tool wrote is never read).
It is read from the prompt a person typed in the terminal, from the prompt given to
`namzu exec` (plain or `--json`) and from a prompt sent over ACP. The turns Namzu
starts itself, such as the report after a workflow or monitor finishes, a goal
round, peer mail, a scheduled run or a resident step, never carry one.
A workflow started in the turn sees it as `budget.total`, and `agent()` throws
once the run has spent that many output tokens, so a script can size itself
(`budget.total ? Math.floor(budget.total / 100_000) : 5`). With the turn's own
token limit set too, the smaller of the two applies.

## Skipping and stopping under a token budget

Stopping a run or skipping an agent cancels a model request that may not have reported its usage. That request is closed on an estimate (the prompt plus what had streamed) instead of being left as unknown spend, so the rest of the turn's budget stays available to the other agents; the estimate can undercount what the provider billed for the unreported part. A request that failed for any other reason, or whose delegation runtime was closed under it, keeps its unknown-spend marker as before.

## Three choices worth knowing

- In `bypass` mode ("bypass permissions on") a workflow starts without a review, like any other call.
- A run has its own token ledger, apart from the turn's: its agents share the turn's budget limit but are counted on the run.
- An agent's `schema` option is carried as an instruction in its prompt, and the reply is parsed and validated against the schema; a reply that does not match makes that agent's `agent()` give `null`.

## Not in this version

Named workflows, nested `workflow()`, worktree isolation per agent, and a pause key.
