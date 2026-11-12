---
type: Reference
title: Goal confirmation - ending a goal by the record
description: The pure decision over what the model reported, the turn's outcome record and the refusal count; the GoalConfirmation controller that holds the report until the answer is finished; the beforeEnd hook of a turn; and what a host passes to switch it on.
resource: packages/sdk/src/tools/goal/confirmation.ts
tags: [sdk, goal, outcome, verification]
status: stable
generated:
  by: claude/sonnet-5.5
  at: 2026-11-12
---

# Goal confirmation

How a goal ends is a choice per goal, `SessionGoal.confirmedBy` (`'model' | 'record'`, absent when the goal did not choose), over a host default. `model` is how goals always ended: `update_goal` with `complete` completes the goal. `record` holds the report until the model has finished its answer and lets the [turn outcome](turn-outcome.md) decide. How a person sees and sets it is on the [goals page](../cli/goals.md).

## The decision

`decideGoalConfirmation({ statement, record, refusals, maxRefusals, earlierRoundsChanged? })` is a pure function: no clock, no I/O, no model. `statement` is what the model reported: `met`, `no-check` (met, and no check exists to run) or `could-not` (the check cannot be made to pass).

| Statement | Record | Decision |
|---|---|---|
| any but `could-not` | `checked` | ends `confirmed` |
| any but `could-not` | `unchanged`, with a passing check | ends `confirmed` |
| `met` | `failing`, `stale`, `unchecked`, `inconclusive` | refuse while `refusals < maxRefusals`, else ends `not-confirmed` |
| `met` | `unchanged` after an earlier round that changed files | refuse, as above |
| `met` | `unchanged`, `unknown`, none | ends `stated-not-checked` |
| `no-check` | `failing`, `stale` | ends `not-confirmed` |
| `no-check` | `unchanged`, `unchecked`, `unknown`, `inconclusive`, none | ends `stated-not-checked` |
| `could-not` | any | ends `not-confirmed` |

A refusal carries a note in the kernel's own words naming what the record holds. `recordSentence(record)` writes that sentence and `describeGoalEnding({ ending, sentence })` the closing line. `DEFAULT_GOAL_REFUSALS` is 3.

## The controller

`GoalConfirmation({ store, resolveAuthority, defaultConfirmedBy?, maxRefusals? })` holds, in memory for a session, the report the model made in the round now running, the refusals each goal has been given, and whether an earlier round of it changed files.

- `buildSessionGoalTools(store, resolve, { confirmation })`: with a goal confirmed by the record, `update_goal` `complete` and `blocked` become reports held by the controller. `complete` with the reason code `no-check-available` is the `no-check` statement; `blocked` is `could-not`, allowed before the third round only once the record has sent the goal back. With no goal confirmed by the record the tools behave exactly as before; their schemas and descriptions do not change.
- `confirmation.beforeEnd(turnId)` is a function for `TurnConfig.outcome.beforeEnd`. For a round of a goal confirmed by the record it reads the record (`read()`), decides, and either returns the refusal note or completes the goal (`confirmed`, `stated-not-checked`) or blocks it (`not-confirmed`, code `not-confirmed-by-record`, the record's sentence in the message) and returns nothing.
- `takeEnding(turnId)` returns the `GoalEndingReport` (`goalId`, `ending`, `sentence`, `refusals`) once, after the turn.
- `forget(goalId)` drops a report that was never answered for, when a round ends without an answer.

## The hook

`TurnConfig.outcome.beforeEnd(read)` is asked when the model has finished with no tool call left and the turn would end, after the [completion audit](completion-audit.md)'s reminder and before the end-of-turn hooks. `read()` gives the record as it stands with the workspace compared once (`OutcomeLedger.preview`, which does not settle the record; the turn's own record is still taken once at its end); it costs nothing unless called. A returned sentence goes to the model as a runtime note and the turn goes on; nothing returned lets it end. A turn stopped by a limit, a cancellation or a forced final answer is not asked, so every limit wins. At most 16 notes are honoured in a turn, and a hook that throws counts as nothing returned.

## The goal tools are not changes

`get_goal` and `update_goal` write the goal, never the workspace. The outcome record treats them as calls that only look, so reporting completion after a check does not make the check read as not known to be fresh. Before this, a report of completion after a passing check on the calls basis read `inconclusive`.

## Limits of what it knows

The record is per turn; see [whose record counts](../cli/goals.md#whose-record-counts). The refusal count and the earlier-round fact are in memory. English is not involved: nothing here reads the model's words, only what its calls did.
