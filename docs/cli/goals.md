---
type: Guide
title: Goals - how a goal continues and how it ends
description: What /goal does, how it keeps working by itself, the limits on that, and the choice of what ends a goal - the model's report (today) or the record the kernel keeps of the work, with its three endings (confirmed by the record, stated and not checked, not confirmed), the refusal bound and whose record counts.
resource: packages/sdk/src/tools/goal/confirmation.ts
tags: [cli, goal, outcome, verification]
status: stable
generated:
  by: claude/sonnet-5.5
  at: 2026-11-12
---

# Goals

A goal is an objective saved with a conversation. `/goal <objective>` (or `/goal set`, see [slash commands](slash-commands.md#goals-and-task-scope)) saves it and arms automatic work: after each reply Namzu starts another round, a turn of its own, until the goal ends, is paused or cleared, or reaches its limit. A round is an ordinary turn that is also offered two tools, `get_goal` and `update_goal`, which no other turn is.

## What ends a goal

| Ending | How |
|---|---|
| Complete | The model calls `update_goal` with `complete`. |
| Blocked | The model calls it with `blocked` and a reason, allowed from the third round on. Or the round limit is reached (256 admitted rounds by default). |
| Paused or cleared | You run `/goal pause` or `/goal clear`. |
| Stopped | A turn that is cancelled, fails or hits a turn limit disarms automatic work; `/goal resume` starts again. |

Today the model's own report is enough: when it says `complete`, the goal is complete, whether or not anything was checked. That is the default, and it is intended to change in a later major release (see [the default](#the-default)).

## Ending a goal by the record

The kernel keeps a record of every turn, built from what its tool calls did and never from what the model says: what changed, what was run to check it, and whether the last word of each check was said about the files as the turn left them ([Turn outcome](../sdk/turn-outcome.md)). With confirmation by the record, a report of `complete` is held until the model has finished its answer, and then the kernel reads that record and decides. There is no judge model and no model call beyond the turns themselves.

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

At most **3 refusals** per goal. After the third, the next report ends the goal as not confirmed with the record's sentence shown. Three because a first refusal normally costs one fix and one rerun of the check, a second covers a fix that did not hold and a third a check that needed a second look; past that the model is looping and each further refusal is a model call that has stopped moving the work. The existing limits win over it: a turn that is cancelled or stopped by a turn limit, a time limit or a budget ends without asking the record, and the round limit still blocks the goal. The count is kept in memory for the session: reopening Namzu gives the model its refusals again.

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
