---
type: Reference
title: Goal confirmation - ending a goal by the record
description: The pure decision over what the model reported, the turn's outcome record and the refusal count; the GoalConfirmation controller that holds the report until the answer is finished; the beforeEnd hook of a turn; the stop rules of a goal, evidence on completion and the optional judge; and what a host passes to switch them on.
resource: packages/sdk/src/tools/goal/confirmation.ts
tags: [sdk, goal, outcome, verification]
status: stable
generated:
  by: claude/sonnet-5.5
  at: 2026-11-22
---

# Goal confirmation

How a goal ends is a choice per goal, `SessionGoal.confirmedBy` (`'model' | 'record'`, absent when the goal did not choose), over a host default. `model` is how goals always ended: `update_goal` with `complete` completes the goal. `record` holds the report until the model has finished its answer and lets the [turn outcome](turn-outcome.md) decide. How a person sees and sets it is on the [goals page](../cli/goals.md).

## The decision

`decideGoalConfirmation({ statement, record, refusals, maxRefusals, earlierRoundsChanged? })` is a pure function: no clock, no I/O, no model. `statement` is what the model reported: `met`, `no-check` (met, and no check exists to run) or `could-not` (the check cannot be made to pass).

| Statement | Record | Decision |
|---|---|---|
| any but `could-not` | `checked` | ends `confirmed` |
| any but `could-not` | `unchanged`, with a passing check | ends `confirmed` |
| `met` | `failing`, `stale`, `unchecked`, `inconclusive`, `unknown` | refuse while `refusals < maxRefusals`, else ends `not-confirmed` |
| `met` | `unchanged` after an earlier round that changed files | refuse, as above |
| `met` | `unchanged`, `unknown`, none | ends `stated-not-checked` |
| `no-check` | `failing`, `stale` | ends `not-confirmed` |
| `no-check` | `unchanged`, `unchecked`, `unknown`, `inconclusive`, none | ends `stated-not-checked` |
| `could-not` | any | ends `not-confirmed` |

`unknown` (a command ran that may have changed files and nothing could tell whether it did) ends as stated, not checked and is never refused: the record keeps `unknown` for the rest of the turn, so a later passing check could not clear it and a refusal would only spend calls until the bound. The closing line says so in the record's own sentence.

A refusal carries a note in the kernel's own words naming what the record holds. `recordSentence(record)` writes that sentence and `describeGoalEnding({ ending, sentence })` the closing line. `DEFAULT_GOAL_REFUSALS` is 3.

## The controller

`GoalConfirmation({ store, resolveAuthority, defaultConfirmedBy?, maxRefusals? })` holds, in memory for a session, the report the model made in the round now running, the refusals each goal has been given, and whether an earlier round of it changed files.

- `buildSessionGoalTools(store, resolve, { confirmation })`: with a goal confirmed by the record, `update_goal` `complete` and `blocked` become reports held by the controller. `complete` with the reason code `no-check-available` is the `no-check` statement; `blocked` is `could-not`, allowed before the third round only once the record has sent the goal back. With no goal confirmed by the record the tools behave exactly as before; their schemas and descriptions do not change.
- `confirmation.beforeEnd(turnId)` is a function for `TurnConfig.outcome.beforeEnd`. For a round of a goal confirmed by the record it reads the record (`read()`), decides, and either returns the refusal note or completes the goal (`confirmed`, `stated-not-checked`) or blocks it (`not-confirmed`, code `not-confirmed-by-record`, the record's sentence in the message) and returns nothing.
- `takeEnding(turnId)` returns the `GoalEndingReport` (`goalId`, `ending`, `sentence`, `refusals`) once, after the turn.
- `forget(goalId)` drops a report that was never answered for, when a round ends without an answer.

## The hook

`TurnConfig.outcome.beforeEnd(read)` is asked when the model has finished with no tool call left and the turn would end, after the [completion audit](completion-audit.md)'s reminder and before the end-of-turn hooks. `read()` gives the record as it stands with the workspace compared once (`OutcomeLedger.preview`, which does not settle the record; the turn's own record is still taken once at its end); it costs nothing unless called. A returned sentence goes to the model as a runtime note and the turn goes on; nothing returned lets it end. A turn stopped by a limit, a cancellation or a forced final answer is not asked, so every limit wins. At most 16 notes are honoured in a turn, and a hook that throws counts as nothing returned.

## Stop rules, evidence and the judge

A goal can carry stop rules, so that it ends by what it does and not by a count of rounds. Every field is optional and an absent one is not applied, so a goal created without them behaves as it always has: `DEFAULT_MAX_GOAL_ROUNDS` stays 256 and is the only limit.

- `CreateSessionGoalParams.guards` (`GoalGuards`): `stallRounds` (turns in a row without progress, or on the same failure, before the goal is blocked), `checkInEvery` (pause after this many admitted rounds, `0` off) and `tokenBudget`. `DEFAULT_GOAL_STALL_ROUNDS` is 3 and `DEFAULT_GOAL_CHECK_IN_ROUNDS` 50, for a host that wants them; the kernel applies neither by itself.
- `SessionGoalStore.recordRound(sessionId, tenantId, goalId, outcome)` (optional on the interface) takes what a finished round did (`GoalRoundOutcome`: `progress` of `progress`, `empty` or `unknown`, `tokens`, `costUsd`, `failureSignature`, `action`, `missing`). It keeps the goal's `tokensUsed`, `costUsd`, `quietRounds`, `failureRounds` and `lastAction` and, on an active goal, blocks it as `no-progress` or `repeated-failure` when a count reaches `stallRounds`. It does not change the goal's revision unless it blocks, so an armed round stays valid.
- `admitRound` checks, in this order: the round cap (`round-limit`, `GoalRoundLimitError`), the token budget (the first admission past it is the last round, `authority.wrapUp`; the next blocks as `budget-limited`, `GoalBudgetLimitError`) and the check-in (the goal becomes `paused` with `pauseReason` of code `check-in`, `GoalCheckInError`, and `checkedInAtRound` is kept). `resumeGoal(..., options)` starts the stall counts again, never resets the round count or the check-in position, and may raise `maxGoalRounds` or `tokenBudget` for a goal a limit stopped.
- `goalUsageSentence`, `goalTokensText` and `goalCostText` write what a goal has used.

`GoalConfirmationOptions.requireEvidence` makes `update_goal` with `complete` need an `evidence` list (`GoalEvidence`: `requirement`, `checked`, `result`; `parseGoalEvidence` checks it, `GOAL_AUDIT_RUBRIC` is the text the model reads). With it off, a bare `complete` ends the goal as before.

- No judge: `selfAudit(goalId, evidence)` holds the first report of a goal once and accepts the next when its evidence covers each requirement the first listed. No model is asked.
- With `judge` (and `judgeActive`, default true when a judge was given): the report is held until the model has given its final answer, then `judge({ sessionId, turnId, objective, evidence, outcome, finalMessage })` runs. `TurnConfig.outcome.beforeEnd(read, { finalMessage })` is how the last message arrives. `met` completes the goal. Not met keeps it active, records the missing list on the goal (`SessionGoal.missing`, handed to the next round as `authority.missing` and then cleared) and returns it as the turn's note, at most `maxRefusals` times; after that the turn ends with the list kept. A judge that returns `undefined` or throws takes the self-audit path and never blocks a goal.

A goal confirmed by the record is not touched by any of this. The stored goal gains only optional fields, so the `session-goal` schema stays at version 2 and an older engine reads and rewrites the record without losing them.

## The goal tools are not changes

`get_goal` and `update_goal` write the goal, never the workspace. The outcome record treats them as calls that only look, so reporting completion after a check does not make the check read as not known to be fresh. Before this, a report of completion after a passing check on the calls basis read `inconclusive`.

## Limits of what it knows

The record is per turn; see [whose record counts](../cli/goals.md#whose-record-counts). The refusal count and the earlier-round fact are in memory. English is not involved: nothing here reads the model's words, only what its calls did.
