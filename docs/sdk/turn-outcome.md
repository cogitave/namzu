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

The record never blocks or prolongs a turn. The [completion audit](completion-audit.md) keeps its own rule and its one reminder.

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
- `turn_completed.settlement.outcome` and `turn_failed.settlement.outcome` in the [session log](session-log.md): an optional field on the settlement, not a new record type. A log written before it has none. A reader built before it refuses a settlement that carries it, as it refuses any field it does not know.
- `child_session_ended.outcome`: the child's own settlement, copied.
- The [checkpoint](session-log.md#documents-beside-the-log) keeps what the ledger gathered (`outcome`, optional). A turn resumed from a checkpoint that has none, such as one written by an earlier version, reports no outcome at all rather than a false `unchanged`: what came before the resume is unknown. Calls that ran after the last checkpoint of a turn that died are not in the record on the calls basis; on the workspace basis the starting fingerprint is kept, so the change is still seen.

## Delegation

The `Agent` tool's `data.outcome` carries the child's record, also when the child failed. When the record has something to say, one line follows the child's marked block in the text the parent model reads, written by the kernel and attributed to the record, never inside the block:

```text
Record of this run: 4 files changed; `pnpm test` passed and nothing changed after it.
Record of this run: 4 files changed; nothing was run to check them.
Record of this run: 4 files changed; `pnpm test | tail -5` ran, but the pipe hides whether it passed.
```

Nothing is added for a child that changed nothing and failed no check. The command is the child's own text, so it is shown only when it is one short line of printable ASCII with no quotes, backticks, `$`, `\` or `#`; otherwise the line says "a command". A line the child writes inside its answer stays inside the block. Readers of the block (`untrustedEnvelopeBody`) skip one trailing kernel record line.

The workflow journal's `agent_outcome` gains the same optional `outcome`; the value a workflow script receives is unchanged.

A child shares the workspace with its siblings, so its check can read `stale` because a sibling wrote. That is the cautious direction and the record does not guess at who wrote what.

## Settings

`TurnConfig.outcome?: { detectChanges?, isCheck?, detectTimeoutMs? }`. The record is kept whether or not it is set; it is additive and cheap on the calls basis. The CLI binds `detectChanges` to the working directory when its tools run there, see [Turn limits](../cli/turn-limits.md#what-a-turn-says-it-changed).

## Related

* [Completion audit](completion-audit.md): the one reminder, unchanged.
* [Answer verification](verification.md): command-backed review of the answer.
