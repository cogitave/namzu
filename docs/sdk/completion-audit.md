---
type: Reference
title: Completion audit - the done-gate
description: The one reminder a turn gets when it tries to end after changing files without running anything to check them - what counts as a check, the one-block cap, and how to switch it on or off.
resource: packages/sdk/src/runtime/query/turn/completion-audit.ts
tags: [sdk, verification, turn]
status: stable
generated:
  by: claude/sonnet-5.5
  at: 2026-10-31
---

# Completion audit

A model that edits code and then answers can skip every check. The completion audit looks at the turn's own record, not at what the model says, and holds the turn back once if the record shows a change and no check after it.

## The rule

- A change is a successful `edit`, `write`, `apply_patch` or `notebook_edit` call.
- A check is a successful `bash` call after the last change whose command runs a test, lint, format-check, typecheck or build target of a project runner (`pnpm test`, `cargo clippy`, `go test`, `make check` and the like) or a checker invoked directly (`vitest`, `pytest`, `tsc`, `biome`, `eslint`, `ruff` and the like). A call that failed does not count, whatever the cause: a check that exits non-zero, is refused or times out leaves the edit unchecked, so the one reminder still follows and the model is asked to run it again and report the result.
- When the model ends the turn with a change and no later check, one reminder is added and the loop goes on: rerun the reproduction, run the tests and the lint or format check, review the diff, name any throwaway file made, and report what ran and what did not.
- When the [turn outcome](turn-outcome.md) record says more than that, the same reminder says exactly what is wrong. It is read from the record as it stands (the calls basis, without asking a workspace detector), and only when a write tool changed a file in the turn:
  - verdict `failing`: names the failing command and says to fix what it reports and run it again;
  - verdict `stale`: names the latest check that passed and says files changed after it, so it must run again;
  - verdict `inconclusive` with a check whose exit status was hidden (`npm test 2>&1 | tail -15`): names that command and says to run it again on its own, without the pipe. Before, such a call counted as a check here, so the turn ended; a check whose status is merely unsettled (background, timed out) still says nothing;
  - anything else with no check after the last change: the message above, unchanged.
- That is the only block a turn gets, whichever wording it had. After it the turn ends however the model answers, so the audit cannot trap a run.

The command a reminder names is one of the turn's own, shown on one line without backticks or control characters and cut at 120 characters; a reminder repeats at most one, so its length is bounded.

A turn that changed no file, or whose last change was followed by a check, ends as before. Changes made through a shell command are not seen as changes.

## Settings

`TurnConfig.completionAudit: true` turns it on; it is off when absent, so an embedding host gets no change. The reminder is recorded as a `progress-nudge` runtime-context message.

The CLI turns it on for the interactive session and for `exec`. `limits.doneGate: false` in the config, or `--no-done-gate`, turns it off. Sub-agents are not audited.

## Related

* [Turn outcome](turn-outcome.md): the record of what the turn changed and what checked it, which also sees shell commands when the host supplies a change detector.
* [Reasoning pace](reasoning-pace.md): the stall monitor, which treats a turn that only edits its task list as having made no progress.
