---
type: Reference
title: Turn outcome - what a turn changed and what checked it
description: The kernel's own record of a turn, built from its tool calls and not from what the model says - the verdicts, what each one does not mean, how a check is recognised and kept honest, and where the record is kept.
resource: packages/sdk/src/runtime/query/turn/outcome-ledger.ts
tags: [sdk, verification, turn, session-log]
status: stable
generated:
  by: claude/sonnet-5.5
  at: 2026-11-10
---

# Turn outcome

`Turn.outcome` answers three questions about a turn from the record of its tool calls, never from its answer:

1. Did the workspace change, and which paths did the write tools change?
2. What was run to check it, and what did each check establish?
3. Was the last word of each check said about the workspace as the turn left it?

The record never blocks or prolongs a turn. The [completion audit](completion-audit.md) keeps its own rule and its one reminder, and, when it is on and a write tool changed a file, words that reminder from the record: `failing`, `stale` and a `masked` check each get their own sentence naming the command. The audit reads the record as it stands (`OutcomeLedger.peek`, the calls basis, no detector call, nothing settled), so the turn's own record is still taken once when it ends.

## The verdict

| Verdict | Means |
|---|---|
| `unchanged` | Nothing differs from the start of the turn (see `basis`). |
| `checked` | Changed; at least one recognised check passed on the final state, and none is left failing. |
| `stale` | Changed; checks passed, but the workspace changed again after every pass. |
| `failing` | The latest run of some check did not pass. Changed or not. |
| `inconclusive` | Changed; checks ran, but none established a pass: the status was hidden, handed to a background job, timed out, or it is not known whether the workspace changed after it. |
| `unchecked` | Changed; no check ran. |
| `unknown` | No write tool ran, but a command that may have changed files did, and no workspace detector answered: whether anything changed cannot be told. |

**`checked` does not mean the change is correct or that the check covers it.** It says a command the kernel recognises as a check exited 0 and the workspace was the same when the turn ended as when that command finished. A test run that never touches the edited file is `checked`.

`failing` wins: if the latest run of any distinct command failed, the verdict is `failing` whatever else passed. A command that failed and was run again and passed is no longer failing.

## What counts as a check

A successful or failed `bash` call whose command line runs a test, lint, format-check, typecheck or build target of a project runner, or a checker invoked directly (the same recogniser the completion audit uses, `isVerificationCommand`), and does not merely name one: `echo "pnpm test"`, `pnpm add -D lint-staged`, `npm install eslint`, `eslint --help` and `tsc --version` are not checks. A failed check stays failed until the same command passes; a later run that never settled does not clear it. `TurnConfig.outcome.isCheck` names a project's own script. Distinct checks are keyed by the command line with its whitespace normalised; the latest run of each is what counts.

Each check is one of:

- `passed`: exit code 0, and the exit status is the check's own.
- `failed`: a non-zero exit, a refusal, or an error.
- `masked`: the command line lets something else decide the exit status. A pipe (`pnpm test | tail -5`; the bash tool does not set `pipefail`), `;` between commands, `||`, a trailing `&`, a group, a nested shell or anything the lexer cannot read to the end. `a && b` is not masked: it exits 0 only if both did. A masked check never counts as passed.
- `unsettled`: handed to a background job, continued, timed out, a non-zero exit that is the command's own answer (`grep` found nothing), or no typed record of the run because a hook replaced the output.

## The basis

`basis: 'calls'` means only the kernel's own write tools were seen. A change made by a shell command, an MCP tool or a delegated agent is invisible, `unchanged` means only that no write tool ran, and a check's freshness is known only when nothing that could change the workspace came after it (`fresh` is absent when a shell command, or another tool not declared read-only, did).

`basis: 'workspace'` means the host supplied `TurnConfig.outcome.detectChanges`, a fingerprint of the workspace (`fingerprintWorkspace` is the kernel's, over what git can see), and the start, each check and the end were compared. The detector is called once before the first call that could change the workspace (anything not provably read-only), once after each check, and once when the turn ends; a turn of read-only calls never calls it. It has a deadline (`detectTimeoutMs`, default 3 s) and a late or failing detector answers `null`.

`null` is never a match. If the start or the end is `null` the whole outcome is `basis: 'calls'`. If the fingerprint after a check is `null`, or a call that could change the workspace followed the check in the same step, that check has no `fresh` and cannot support `checked`.

A write tool that succeeded counts as a change even when the detector sees none (an ignored file), and a check followed by one is stale. `changes.outsideKnownTools` is true when the workspace moved and no write tool call explains it; that includes a check that itself writes files (a coverage directory), so a turn that only ran tests can report it.

## Bounds

At most 50 paths and 20 checks are kept, with `changes.total` and `checksTotal` saying how many there were; a command is cut at 300 characters. No file content and no command output is recorded. The verdict is computed over every check, not only the kept ones.

## Where it is kept

- `Turn.outcome` and `BaseAgentResult.outcome`. Absent for a turn that never ran the loop.
- The [session log](session-log.md#record-only-types) keeps it in three records of their own, each flagged `ignorable`: `turn_outcome_recorded` just before the turn's `turn_completed` or `turn_failed`, `child_outcome_recorded` in the parent's log just before a child's `child_session_ended`, and `outcome_progress_written` just before the `checkpoint_written` of the checkpoint it belongs to. It is never a field of `turn_completed`, `turn_failed`, `child_session_ended` or the checkpoint document: an earlier release validates those strictly and would refuse the whole log or checkpoint. It skips the three new types instead, so an earlier release reading a newer log loses only the outcome. A log written before these records has none. A test pins the key sets of the three older shapes.
- Reading back: `readTurnOutcome` and `foldTurnOutcomes` return what a turn recorded, `foldChildOutcomes` what a child recorded, from the log. A body that does not parse as a `TurnOutcome` reads as no outcome.
- The live `turn_completed` and `turn_failed` events carry the record on `settlement.outcome` in memory (`LiveTurnSettlement`); the persisted settlement does not have it.
- A resume restores what the ledger gathered from the `outcome_progress_written` record that names the checkpoint. A turn resumed from a checkpoint with no such record, such as one written by an earlier version, reports no outcome at all rather than a false `unchanged`: what came before the resume is unknown. Calls that ran after the last checkpoint of a turn that died are not in the record on the calls basis; on the workspace basis the starting fingerprint is kept, so the change is still seen.

## Delegation

The `Agent` tool's `data.outcome` carries the child's record, also when the child failed. When the record has something to say, one line follows the child's marked block in the text the parent model reads, written by the kernel and attributed to the record, never inside the block:

```text
Record of this run: 4 files changed; `pnpm test` passed and nothing changed after it.
Record of this run: 4 files changed; nothing was run to check them.
Record of this run: 4 files changed; `pnpm test | tail -5` ran, but the pipe hides whether it passed.
```

Nothing is added for a child that changed nothing and failed no check. The command is the child's own text, so it is shown only when it is one short line of printable ASCII with no quotes, backticks, `$`, `\` or `#`; otherwise the line says "a command". A line the child writes inside its answer stays inside the block. Readers of the block (`untrustedEnvelopeBody`) skip one trailing kernel record line.

The workflow journal's `agent_outcome` gains the same optional `outcome`; the value a workflow script receives is unchanged. The journal needed no record of its own: it is read as plain JSON lines chained by hash, with no field-by-field validation, so an earlier release ignores a key it does not know.

A child shares the workspace with its siblings, so its check can read `stale` because a sibling wrote. That is the cautious direction and the record does not guess at who wrote what.

## The answer against the record

`compareAnswerToOutcome(answer, outcome)` (`packages/sdk/src/runtime/query/turn/answer-claims.ts`, exported) checks what the answer plainly claims about checks against this turn's record. It is a pure function: no model call, no clock, no I/O. The model's words only select which statement to check; the statement it returns is about the record, so the kernel never says more than the record establishes. It never throws: input that is not the expected shape reads as nothing to say. It returns nothing, or one `AnswerClaimMismatch`: the claim (`tests`, `build`, `lint`, `typecheck` or `checks`), what it said in the kernel's words (`the tests pass`), the clause it was found in, which part of the record disagrees (`check-failed`, `unchecked` or `unreadable`) and that part in words (`pnpm test failed`). `describeAnswerClaimMismatch` writes it as the one line a person reads: `The answer says the tests pass. The record: pnpm test failed.`

**What it finds.** Only plain, present, positive claims about a check: the tests pass (also `tests are green`, `the test suite passes`, `no test failures`), the build succeeds (`it builds cleanly`), lint is clean (`no lint errors`), type checking passes (`no type errors`), `all checks pass`, and the label form of a summary list (`Tests: passing`). The patterns, and the reason for each, are one list in the source (`ANSWER_CLAIM_PATTERNS`), as are the words that cancel a claim.

**When it reports.** Only when the record of this same turn says:

* `failing`, and a failed check is one the claim is about. A failed check that is plainly another kind (`pnpm lint` failed, the answer says the tests pass) is no mismatch; a failed command of no recognisable kind counts for every claim, and a chained command (`pnpm lint && pnpm test`) is every kind it names.
* `unchecked`: files changed and no check ran.
* `inconclusive`: files changed and no check established a pass, or its result could not be read.

**What it never reports.** A turn whose record is `unchanged`, `checked`, `stale` or `unknown`, and a missing record: a claim may be true of an earlier turn, or of a check that really passed. And it is silent on a negation (`the tests did not pass`), a hedge, a condition or a plan (`should pass`, `if the tests pass`, `once the build succeeds`, `make sure the tests pass`), a question, a quotation in double quotes or a block quotation, an inline code span or fenced code, what someone else said (`the CI page says`), a hedge or a negation after the claim (`the tests pass, apparently`, `tests passing is the goal`), the past before this change (`passed before my change`), a qualified claim (`all but one`, `38 of 40`), a sentence that also names a failure (`the build succeeds but the tests fail`), and the singular `the test passes`, which is usually about one test just fixed. When two claims are found the first is reported.

**English only for now.** A claim in another language is not found: the patterns are English words, so an answer in another language gets no line, and nothing is said about that. This is deliberate under-reporting, not an unsupported setting.

**Shadow only.** The mismatch is recorded and shown, never acted on: the model is not told, nothing blocks, and no later step is routed on it. It travels with the turn in memory: `LiveTurnSettlement.claimMismatch` on the live `turn_completed` event (the persisted settlement and the session log do not have it, since the existing `turn_outcome_recorded` record is strictly validated by earlier releases and a new field on it would break reading, and a record of its own was left out until the numbers say the line is right), `claimMismatch` on the `done` event of the terminal's agent session and as a key on the result of `namzu exec --output-format json` and the `done` line of `exec --json`, and `EvalTurn.claimMismatch` for the eval suites. A conversation reopened from the log shows the same line in the terminal: the comparison is pure, so the terminal works it out again from the saved answer and the saved record.

**Measuring it.** `evalTurnFromTurn` carries `Turn.outcome` onto `EvalTurn.outcome` and the mismatch onto `EvalTurn.claimMismatch`. `outcomeScorer(verdicts)` scores 1 when the record's verdict is one of the given set and 0 otherwise, naming the verdict, and is unavailable (not zero) for a turn with no record; `claimMismatchScorer({ expectMismatch? })` scores whether the comparison fired. Both are gate scorers, so a scripted suite with no provider can pin the kernel's record and the comparison. `@namzu/evals` has the suite `kernel/answer-claims`, and the SDK's unit test holds a table of answers (claims, negations, hedges, quotations, code, mixed sentences, long answers) with the expected result of each.

## Handed back

A turn the model [handed back to a person](hand-back.md) keeps its record unchanged: `Turn.handedBack` is a separate fact beside the verdict, in memory and on the live settlement, and is read back from the saved `hand_back_task` call, so the persisted outcome record gains no field.

## Ending a goal by the record

A goal can end only as this record allows (`GoalConfirmation`, the `TurnConfig.outcome.beforeEnd` hook, `OutcomeLedger.preview`): see [Goal confirmation](goal-confirmation.md). The goal tools (`get_goal`, `update_goal`) count as calls that only look, so a report of completion after a passing check leaves the check fresh.

## Settings

`TurnConfig.outcome?: { detectChanges?, isCheck?, detectTimeoutMs?, beforeEnd? }`. The record is kept whether or not it is set; it is additive and cheap on the calls basis. The CLI binds `detectChanges` to the working directory when its tools run there, see [Turn limits](../cli/turn-limits.md#what-a-turn-says-it-changed).

## Related

* [Completion audit](completion-audit.md): the one reminder, worded from this record.
* [Answer verification](verification.md): command-backed review of the answer.
