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
- That is the only block a turn gets. After it the turn ends however the model answers, so the audit cannot trap a run.

A turn that changed no file, or whose last change was followed by a check, ends as before. Changes made through a shell command are not seen as changes.

## Settings

`TurnConfig.completionAudit: true` turns it on; it is off when absent, so an embedding host gets no change. The reminder is recorded as a `progress-nudge` runtime-context message.

The CLI turns it on for the interactive session and for `exec`. `limits.doneGate: false` in the config, or `--no-done-gate`, turns it off. Sub-agents are not audited.

## Related

* [Turn outcome](turn-outcome.md): the record of what the turn changed and what checked it, which also sees shell commands when the host supplies a change detector.
* [Reasoning pace](reasoning-pace.md): the stall monitor, which treats a turn that only edits its task list as having made no progress.
