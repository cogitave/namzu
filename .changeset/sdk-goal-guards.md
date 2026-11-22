---
'@namzu/sdk': minor
---

Session goals can be stopped by what they do instead of by a count of rounds, and a completion report can carry evidence. Nothing changes for a host that passes none of the new fields: `DEFAULT_MAX_GOAL_ROUNDS` is still 256 and no stop rule is applied.

New and optional: `CreateSessionGoalParams.guards` (`stallRounds`, `checkInEvery`, `tokenBudget`); `SessionGoalStore.recordRound` (counts a finished round's tokens, cost, progress and failure, and blocks the goal as `no-progress` or `repeated-failure`); `admitRound` pausing a goal for a check-in (`GoalCheckInError`), giving one last round at the token budget and then blocking it (`GoalBudgetLimitError`); `resumeGoal` taking raised limits and not resetting the round count; `GoalConfirmationOptions.requireEvidence`, `judge` and `judgeActive` with `GoalEvidence`, `GoalJudge` and `parseGoalEvidence`; `update_goal` accepting an `evidence` list; `TurnConfig.outcome.beforeEnd` receiving `{ finalMessage }` as a second argument; and the `/goal set` options `--token-budget` and `--max-rounds` with `GoalCommandScope.defaults`. `/goal status` now prints `Automatic turns: N, up to M` with `Tokens` and `Cost` lines instead of `N / M`.
