---
type: Reference
title: Plan mode in the CLI
description: What plan mode lets the model write, how it presents a plan and what the approval box offers, which mode each answer switches to, the hidden reminders that restate the rules and nudge the task list, and what Desktop would still need.
resource: packages/cli/src/plan/exit-plan-mode-tool.ts
tags: [cli, plan-mode, permissions, reminders]
status: stable
generated: { by: process:claude-code, at: 2026-10-19T00:00:00Z }
---

# Plan mode in the CLI

Plan mode (`‖ plan mode on`, reached with Shift+Tab or `/permissions plan`) lets the model read, search and think but not change anything. Since 2026-10-19 it also has a way out that does not depend on you typing "go ahead": the model writes its plan to a file, presents it, and you approve it. The labels are in our own words. [Terminal design](terminal-design.md) and [Slash commands](slash-commands.md#permissions) describe the rest of the mode.

## The plan file

Plan mode keeps one plan file per session, inside the session's own directory:

| | Namzu |
|---|---|
| Where | `~/.namzu/projects/<slug>/<session-id>/plans/plan.md` (`SessionPaths.planFile`) |
| Who may write it | the model, in plan mode, with the write and edit tools |
| A directory setting | none |
| Sub-agents | none: delegated agents in plan mode only read |

In `plan` every other change is still refused with the plan-mode feedback, a `deny` rule still wins, and a rule that asks to review a write to the plan file still has its question asked. The check is the call's resolved path, so only exactly that file passes: a sibling, a prefix or another tool does not. The file is not removed when the plan is approved; it is part of the session and `/resume` finds it with the conversation.

## Presenting the plan

The model finishes planning by calling `exit_plan_mode`, which takes no arguments and reads the plan from the file, so what you approve is what is on disk. It refuses, with a reason the model can act on, when the mode is not `plan`, when the file is missing or blank, and when nobody can answer (a headless run: the model is told to end its reply with the plan and say which mode to switch to). The tool is the terminal's own; delegated agents and `namzu exec` do not have it.

The approval box shows the plan, then:

1. **Yes, and auto-approve edits**: leaves plan mode for `accept-edits`. When the session may run without asking (`--yolo`, `--dangerously-skip-permissions`, `--permission-mode bypass`, `--allow-dangerously-skip-permissions`, or `permissions.defaultMode: bypass`), this row is **Yes, and run every tool without asking** and leaves for `bypass`.
2. **Yes, and ask before each edit**: leaves plan mode for `prompt`.
3. **No, keep planning**: a text row. Type what to change and press Enter; the words go to the model as the reason the plan was not approved, and the mode stays `plan`. Enter on an empty text row does nothing.

Keys: ↑/↓ or a digit pick a row, Enter takes it, PgUp/PgDn page a long plan, typing anywhere starts the text row, Esc keeps planning without words, Shift+Tab approves row 1 with whatever is typed, Ctrl+C stops the reply. Approving waits out the same settle window every consent screen waits out, so a key already in flight cannot approve a plan you have not read; refusing never waits.

Approving applies the mode through `applyPermissionMode`, the change Shift+Tab makes, before the tool answers, so the turn's next decision is already made under it and the footer says `accept edits on` (or nothing, for `prompt`). The model reads the approved plan, where it is saved and any words you typed with Shift+Tab. The plan file is named "the plan" wherever the screen mentions it (`Write(the plan)`, `Wrote 12 lines to the plan`, `Saved as the plan`), never by its folder; the transcript gets `✓ Plan approved · <mode>` with the plan under it (collapsed, `ctrl+o` expands); words typed to keep planning appear as `Changes asked for · …`.

## Reminders

A turn in the terminal is fed hidden reminders through the SDK's [reminder channel](../sdk/reminders.md): user-role runtime messages that are part of the history but never drawn in the transcript (a resumed conversation does not show them, an export labels them `Reminder`). Each opens with a tag line (`<system-reminder kind="…">`) that a later request reads to know what was already said.

**Plan mode.** Reminder cadence:

- Nothing is sent unless the mode is `plan` or has just stopped being it.
- The first reminder of a stretch is sent at once (the first request after the mode is entered, even mid-reply). After that, one is sent only when 5 operator messages have gone by since the last; model requests inside one reply do not count.
- The 1st, 6th, 11th … reminder of a stretch carries the full rules; the ones between are one line naming the plan file and the two ways a turn may end.
- Re-entering plan mode after leaving it, with a plan file already there, adds a note: read the old plan first, start over if the task is different, revise it if it is the same, and edit the file before presenting.
- Leaving plan mode, by an approval or by Shift+Tab, sends one note that the mode is off and where the plan is.

The full text: change nothing except the plan file, understand the request and look for code to reuse, settle on one approach, write context, approach, files, reuse and verification, and end the turn only by asking the user a question or by calling `exit_plan_mode`, never by asking in plain text whether the plan is fine.

**Task-list nudge.** After 10 model turns (assistant messages) without `task_create` or `task_update`, and at most once per 10 model turns, the model is reminded that the task tools exist and shown the current list (`#<id>. [<status>] <subject>`). The counts come from the conversation, so they survive a resume and start again when compaction shed the history they were counting.

## What this does not do, and what is open

- **No clear-context row.** The "Yes, clear context and …" rows appear only with a setting; Namzu has no setting and no clear-and-continue path, so they are not offered.
- **No plan editing in the box.** The plan is read-only in the box (the file can be edited on disk before answering, and the next `exit_plan_mode` reads it again).
- **No cloud refinement row** and no `plansDirectory`.
- **No `ultraplan`, no phased exploration prompt with a built-in plan agent**; the full reminder says to use read-only explore agents for wide questions.
- **An empty plan.** The tool answers the model that there is nothing to approve.
- **Esc with no words** keeps planning.
- **Desktop and `namzu exec`** do not have the box, the tool or the reminders. Desktop would need: the `exit_plan_mode` tool mounted by the CLI host with a request/answer pair on the host protocol (the plan, its path, `bypassAvailable`; an answer of mode or words), a plan review view with the same three rows and a text field, the host forwarding `reminders`/`planApproval` to its sessions, the plan file reachable from the conversation, and the ACP bridge deciding what an ACP client sees (today only the native-engine adapter for a foreign agent reacts to that agent's own plan-exit request; see [Native engines](native-engines.md)).
