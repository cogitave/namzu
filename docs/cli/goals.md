---
type: Guide
title: Goals - how a goal continues and how it ends
description: What /goal does, how it keeps working by itself, what stops it (no progress, the same failure, a check-in every 50 turns, an optional token budget, a 1000-turn backstop), how a completion report is checked (evidence, a judge when the decision model is on, a self-audit when it is off), and the choice of ending a goal by the record of the work.
resource: packages/sdk/src/tools/goal/confirmation.ts
tags: [cli, goal, outcome, verification]
status: stable
generated:
  by: claude/sonnet-5.5
  at: 2026-11-22
---

# Goals

A goal is an objective saved with a conversation. `/goal <objective>` (or `/goal set`, see [slash commands](slash-commands.md#goals-and-task-scope)) saves it and arms automatic work: after each reply Namzu starts another round, a turn of its own, until the goal ends, is paused or cleared, or a rule stops it. A round is an ordinary turn that is also offered two tools, `get_goal` and `update_goal`, which no other turn is.

A goal is not stopped by a fixed number of turns. It stops when it is done, when it is stuck, or when it reaches a check-in; the number of turns is only a backstop.

## What ends a goal

| Ending | How |
|---|---|
| Complete | The model calls `update_goal` with `complete` and evidence, and the report is accepted (see [how completion is checked](#how-completion-is-checked)). |
| Blocked | The model calls it with `blocked` and a reason, allowed from the third round on, or hands the round back to a person (see [a goal handed back](#a-goal-handed-back); only with `handBack.enabled`). Or a [rule](#what-stops-a-goal) stops it: no progress, the same failure again, the token budget, or the backstop. |
| Paused or cleared | You run `/goal pause` or `/goal clear`, or the goal pauses itself for a [check-in](#what-stops-a-goal). |
| Stopped | A turn that is cancelled, fails or hits a turn limit disarms automatic work; `/goal resume` starts again. |

## What stops a goal

These rules read what each automatic turn did, from the kernel's record of its calls. Each has a setting (see [the settings](#the-settings)) and every one is on by default except the token budget.

| Rule | When it applies | What you see | Going on |
|---|---|---|---|
| No progress | 3 automatic turns in a row changed no file, ran no command that could have, ran no check, and did not report completion. | The goal is blocked as `no-progress`; the line names the last action it took and what has been used so far. | `/goal resume` starts the count again. |
| Repeated failure | The same check failed in 3 automatic turns in a row (the same command, the same exit code). | The goal is blocked as `repeated-failure`, naming the failure. | Fix the cause, then `/goal resume`. |
| Check-in | After every 50 admitted rounds. | The goal pauses and says how many turns, tokens and what cost it has used. | `/goal resume` continues with no count reset; the next check-in comes 50 turns later. `goal.checkInEvery: 0` turns check-ins off. |
| Token budget | Only when `goal.tokenBudget` (or `--token-budget`) is set: the goal has used that many tokens. | The goal gets one last round, told to wrap up and start nothing new, then is blocked as `budget-limited`. | Raise `goal.tokenBudget` and run `/goal resume`. |
| Backstop | 1000 admitted rounds (`goal.maxRounds`). | The goal is blocked as `round-limit`. | Raise `goal.maxRounds` and run `/goal resume`: a resume uses the setting when it is larger than the goal's own cap. |

A turn counts as having made progress when files changed, a command ran that may have changed them, or a check ran. A turn that did none of these and did not report completion is an empty turn; a turn with no record at all counts as neither. A stop is a block, not an error: `/goal status` shows the reason, and the work already done is kept.

## How completion is checked

`update_goal` with `complete` needs an `evidence` list: one entry per requirement of the objective, each with the requirement, what was checked and what the check showed. The prompt of every round carries the same rubric: restate the requirements, check each against the current state, treat intent or earlier work as no proof, and keep working when the evidence is weak. What happens next depends on whether the decision model is on.

**With the decision model on** (a decision model is connected and the `goal` [decision point](decision-points.md) is `on`, which is its start mode; `shadow` counts as off), a judge runs only when the model claims completion. The report is held until the model has given its final answer. The judge is shown the objective (as data), the evidence, a line from the turn's record and the final message, and answers whether the goal is met and what is missing.

- Met: the goal is complete.
- Not met: the goal stays active, the missing list goes back to the model in the same turn, and it also leads the next round. This is limited to 3 times per goal; after that the turn ends and the list leads the next round.
- The judge runs on the model `goal.judgeModel` names. Not set, it runs on the model for quick tasks (`smallModel`, else the cheapest priced model of the conversation's vendor, else the conversation's model). The goal, its evidence and the last answer are sent to that model.
- A judge that cannot answer (no credential, an error, 30 seconds without a reply, a reply that is not an answer) never blocks the goal: the report takes the path below.

**With the decision model off**, no extra model is asked. The first completion report of a goal is handed back once with the rubric; the second is accepted when its evidence covers each requirement the first one listed, each with what was checked and the result. A report that leaves one out is handed back again, naming it.

`goal.confirmedBy: record` (below) is unchanged and is still opt-in. Evidence is asked for on a goal confirmed by the model; a goal confirmed by the record is decided by the record as before.

## The settings

| Setting | Default | Meaning |
|---|---|---|
| `goal.maxRounds` | 1000 | Backstop on automatic turns per goal. |
| `goal.checkInEvery` | 50 | Pause for a check-in after this many automatic turns, and again after each further batch. `0` turns it off. |
| `goal.tokenBudget` | not set | Tokens one goal may use. Not set means no budget. |
| `goal.stallRounds` | 3 | Automatic turns in a row without progress, or ending on the same failure, before the goal stops. |
| `goal.judgeModel` | not set | The model that checks a completion report when the decision model is on, as `provider/model` or a model of the current provider. |
| `goal.confirmedBy` | `model` | See [the setting and the flag](#the-setting-and-the-flag). |

All of them are in Settings (Agent) and in `~/.namzu/config.yaml` or `namzu.config.json` under `goal:`. A goal takes the values when it is set; `/goal set --token-budget <n>` and `--max-rounds <n>` give one goal its own. `/goal status` and the line that starts each round show the automatic turns, the tokens and the cost so far.

## Ending a goal by the record

The kernel keeps a record of every turn, built from what its tool calls did and never from what the model says: what changed, what was run to check it, and whether the last word of each check was said about the files as the turn left them ([Turn outcome](../sdk/turn-outcome.md)). With confirmation by the record, a report of `complete` is held until the model has finished its answer, and then the kernel reads that record and decides. There is no judge model and no model call beyond the turns themselves; the [evidence check](#how-completion-is-checked) above is for goals the model confirms.

### The three endings

| Closing line | When |
|---|---|
| `Goal confirmed by the record: <command> passed and nothing changed after it.` | A recognised check passed and nothing changed after it. |
| `Goal stated, not checked: the record cannot confirm it (<what the record holds>).` | The record cannot confirm or contradict the report: nothing changed in the round and no check ran, or whether anything changed cannot be told, or there is no record, or the model said plainly that no check exists here. |
| `Goal not confirmed: the record says <what the record holds>.` | The record disagrees and the model did not put it right within the bound, or the model said plainly that it could not make the check pass. The goal is left blocked, with the record's sentence as its reason, so `/goal status` shows it. |

### When the goal does not end

If the record says a check failed, files changed after the last passing check, files changed and no check ran, or a check ran and its result could not be read, the goal does not end. The kernel adds one plain note to the same turn in its own words, and the model carries on. For example:

> The record says files changed after the last passing check. Run the check again, or say plainly that you could not.

The note ends with how to say so: `update_goal` with `blocked` and a reason when the check cannot be made to pass (this ends the goal as not confirmed, and is allowed in the first round once the record has sent the goal back), or with `complete`, the reason code `no-check-available` and a reason when no check exists here (this ends it as stated, not checked). A refusal is counted, not a new round: it does not use one of the goal's admitted rounds.

### The bound

At most **3 refusals** per goal. After the third, the next report ends the goal as not confirmed with the record's sentence shown. Three because a first refusal normally costs one fix and one rerun of the check, a second covers a fix that did not hold and a third a check that needed a second look; past that the model is looping and each further refusal is a model call that has stopped moving the work. The existing limits win over it: a turn that is cancelled or stopped by a turn limit, a time limit or a budget ends without asking the record, and the [stop rules](#what-stops-a-goal) still block the goal. The count is kept in memory for the session: reopening Namzu gives the model its refusals again.

### Whose record counts

The record of the turn in which completion is reported, and only that. The ledger keeps one record per turn and no running record across a goal's rounds, so a pass in an earlier round says nothing about the files now. One thing is taken from earlier rounds, always in the cautious direction: when this round changed nothing and ran no check but an earlier round of the same goal changed files, the report is not read as "nothing needed checking"; it is refused like files changed with no check. An earlier round never turns a refusal into a confirmation. Work done in a reply of your own between rounds is not part of any goal round's record. If the check ran in an earlier turn and this turn only reports, the model is asked to run it again in this one.

What `checked` means is as narrow as it is in the record: a command Namzu recognises as a check exited 0 and the files were the same when the turn ended as when it finished. It does not say the check covers the change.

### The setting and the flag

- **Per person:** `goal.confirmedBy` in `~/.namzu/config.yaml` or `namzu.config.json`, `model` (the default) or `record`.
- **Per goal:** `/goal set --confirmed-by record <objective>` (also `--confirmed-by=record`, and on a direct `/goal <objective>`). A goal that chose keeps its choice against the setting; one that did not follows the setting. The choice is saved with the goal. `/goal status` shows `Confirmed by: the record of the work` when it applies.

With `model`, and no goal that chose `record`, the goal tools, their descriptions and how a goal ends are unchanged. One thing differs for every goal: a call to `get_goal` or `update_goal` is counted as a call that only looks, so it no longer makes a turn's outcome record read as changed files. The flag is read only at the front of the command or right after `set`; later words belong to the objective.

### The default

The default is `model` because ending by the record changes how an existing command ends. It is intended to become `record` in a later major release; a person who wants the present behaviour then sets `goal.confirmedBy: model`.

## What you see, and scripts

The closing line above is shown under the turn's outcome line, once, in the turn that ended the goal. It is not saved in the conversation, so a reopened conversation shows the goal's phase (`complete` or `blocked` with the record's sentence) and not which of the first two endings it was.

`namzu exec --output-format json` and the `done` line of `exec --json` carry the same facts as an optional `goalEnding` key: `goalId`, `ending` (`confirmed`, `stated-not-checked` or `not-confirmed`), `sentence` and `refusals`. It is absent unless a goal ended in the command. `exec` does not set goals today and scheduled tasks do not run them, so the key is never present there yet, and no exit status is defined for a not-confirmed goal in those runs: when they do run goals, that exit status will be documented with them.

## A goal handed back

When the model is allowed to [hand a task back to a person](../sdk/hand-back.md) (`handBack.enabled`) and does so in a goal round, the round ends there and the goal ends as **not confirmed**, whatever it was confirmed by: it is left blocked with the code `handed-back-to-a-person` and the reason, so `/goal status` shows it. The closing line is `Goal not confirmed: the model handed the task back to a person (<the kind's sentence>).`, with the model's three sentences under it, labelled as the model's. `goalEnding` carries `handedBack` as well. With the setting off (the default) nothing here changes.

## Measured on the scripted suite

`namzu eval` runs `kernel/goal-by-record` with a scripted model, so the numbers are what the kernel does, not what a model would claim. Each scenario runs under the present behaviour and with the record; "calls" are model calls in the turn.

| Scenario | Model's report ends it | Record confirms it |
|---|---|---|
| Reported met after a failing check, then fixed | 4 calls, ended complete over a failing check | 8 calls, confirmed after one refusal; record `checked` |
| Reported met after editing past a passing check | 5 calls, ended complete, record `stale` | 8 calls, confirmed after one refusal; record `checked` |
| Reported met, no check available | 3 calls, ended complete, record `unchecked` | 3 calls, stated and not checked |
| A check that never passes | 4 calls, ended complete over a failing check | 13 calls, not confirmed after three refusals |

The four extra calls in the first two rows are the price of the check that was missing; the 13 in the last row is the bound.

## Related

- [Turn outcome](../sdk/turn-outcome.md): the record and its verdicts.
- [Goal confirmation in the SDK](../sdk/goal-confirmation.md): the decision, the hook and the exports.
- [Completion audit](../sdk/completion-audit.md): the separate reminder a turn gets when it ends after changing files with no check.
