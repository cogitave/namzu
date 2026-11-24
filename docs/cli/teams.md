---
type: Guide
title: Teammates
description: How teammates are turned on (the teams.enabled setting, NAMZU_TEAMS and --teams), how a named Agent call starts one and how it runs, the shared task list and mail, how a teammate's permission asks and plans reach you, its hook events, the team on the terminal (rows, transcript, stop, `/team`, the task list), the limits that apply, and where they do not run.
resource: packages/cli/src/integrations/teams/
tags: [cli, teams, teammates, settings, experimental]
status: draft
generated: { by: "claude-sonnet-5", at: "2026-11-24" }
---

# Teammates

A teammate is a named helper that keeps its own conversation beside the main one, can message the other teammates, and shares a task list with them. In a conversation where teammates are on, the `Agent` tool given a `name` starts a teammate; without a name, or with teammates off, it starts a plain sub-agent exactly as before. This page covers the switch, how a teammate runs, how its permission asks and plans reach you, the hook events, the team on the terminal (rows under the prompt, `/team`, the task list), and the limits. The Desktop team panel and the `namzu team` command are later steps.

## Turning them on

Off by default. Any one of these turns them on:

- the setting `teams.enabled` (Settings, Helpers and workflows, *Teammates*; or `namzu config set teams.enabled true`),
- `NAMZU_TEAMS=1` in the environment,
- `namzu --teams` for one launch (a settings layer that wins over your files and loses to the managed file).

`NAMZU_TEAMS=0` (also `off`, `false`, `no`) is a hard stop that wins over all three. Teammates never run in a headless run (`exec`, print mode, a schedule, `serve`, a Pal), whatever is set. The answer is read again at every named `Agent` call, so a change takes effect on the next call without a restart; teammates already running are not stopped by it.

These settings are your own config file's and the managed file's. A repository's `.namzu/config.yaml` cannot set them: a project must not start helpers that spend your limit.

## How a teammate runs

The first named `Agent` call creates the team of the conversation, `team-` and the last eight characters of the lead session's id (the start of that id is the same for every session of the same weeks, so the end is the part that tells sessions apart). The call reserves the name in the team's file, starts the teammate and returns at once; if starting fails the name is given back. A name must pass the same rule as a team member's name in the SDK (`lead`, `main`, `team-lead`, `user`, `system` and id-shaped names are refused). `workspace: "worktree"` and the `fork` type are refused for a teammate for now: a teammate has to be woken for more work, and it shares the lead's checkout, so give teammates files that do not overlap.

A teammate runs inside the lead's process, as a child session with its own history and its own stop. It receives the brief you gave plus a short note: plain text is seen by nobody, so it must call `send_message`, and the task tools are its way to the shared list. It runs under its own turn of the conversation, so it outlives the turn that started it; its permission asks go to you in the lead's conversation, with its name on them (see [Permission asks and plans](#permission-asks-and-plans)). Its model is the one the call named, else the session's.

When a teammate's turn ends it does not end. It goes **idle**: the lead hears it like any background agent finishing, and the team keeps one idle line in the lead's mailbox. An idle teammate wakes when

- mail arrives for it (a `send_message` from the lead or another teammate, written to its mailbox and handed over at once),
- a task nobody owns, that is pending and not waiting on another, appears in the team's list: it takes the lowest one, claims it under its name and works on it, or
- the next look at the list, every five seconds, finds one that another process added.

A teammate whose last turn failed waits for mail instead of taking another task, so a failure does not repeat on its own. An idle teammate also takes a pending task the lead assigned to it by name (`task_update` `owner`), and when a claimed task cannot be handed to it the task stays with it, it waits for mail, and the lead is told which task is stuck. `stop_task` on a teammate's name stops it between turns too: it takes no more mail and claims no more tasks. Mail from a teammate is handed over wrapped as data, so words that imitate the lead's frame or a shutdown request are not taken for one. After `teams.idleExitMinutes` with nothing to do it ends and gives its place back; a message to it later resumes it from its saved conversation (if the team is under `teams.maxTeammates` again). At most 8 messages from one member to another in a minute are accepted, so two cannot answer each other without end. When the lead's conversation closes every teammate is stopped and the team's directory is removed; the task list and the transcripts stay.

Mail is always labelled to the receiver as coming from another session in the team, never from the person: it cannot approve anything for the receiver or grant permission, and what it says is not proof of anything. A teammate's message to the lead reaches the lead's conversation as "Teammate <name> (another session in your team, not the person)". Teams are not resumable: a lead that is resumed does not restart its teammates.

### Messages, idle notices and shutdown

The lead sends to a teammate by name with `send_message`; a teammate sends to the lead (`lead`) and to other teammates by name. Every message is written to the receiver's mailbox file (the record, and the source for a member that is not running) and handed to the receiver at once; a message to an idle teammate wakes it, and one to a teammate that ended after the idle limit resumes it from its saved conversation. A receiver always reads it as coming from another session in the team, never from the person, and it cannot grant a permission. When a teammate goes idle the lead gets one notice per turn: who, why (available, interrupted or failed), and a short result.

Two teammates cannot answer each other without end. After 12 messages between teammates in a row, with no task change, claim or message to or from the lead in between, the next one is refused, the sender is told why, and the lead gets one notice so it can step in. Any of those events starts the count again.

The lead asks a teammate to shut down by calling `send_message` with `shutdown: true` (the message is the reason). The teammate finishes the call it is on, then answers with `shutdown_response`: approve, and it stops when its turn ends, or refuse with a reason, and it carries on while the lead is told why. If it has not answered within `teams.shutdownGraceSeconds` it is stopped. Either way the member leaves the team and its name can be used again; its tasks stay. Only the lead asks. A teammate that had already ended after the idle limit just leaves.

## Permission asks and plans

A teammate never asks in a screen of its own. When one of its calls needs a yes, the question is put to you in the lead's conversation exactly as one of the lead's own calls would be, with the teammate's name first in the title: `writer wants to run a command`, `writer wants to edit src/a.ts`. The question is tied to that one call (by the call's id and the session that raised it): your answer goes back to that teammate and no other, and two teammates that ask at the same moment are two separate questions. Nothing a teammate writes, or mails to the lead or another teammate, can answer a question or change it; only your answer does, and mail is written to the receiver as data from another session, never as you. If you do not answer, the teammate waits.

Which calls are asked about, and what the lead's modes do, is the same as for a sub-agent today: a teammate runs under the lead's permission mode as it is at each call and under the lead's rules, so in `bypass` it is not asked, in `plan` it is refused what plan refuses, and "yes for the rest of the session" answers and the accept-edits answer mean what they mean for the lead's own calls. Under the Agent Client Protocol (the Desktop engine) the permission request carries `teammate: { name, team }`, which a client shows with the question.

A teammate that wants a plan approved before it changes anything calls `exit_plan_mode` with the plan (the plan is the call's `plan` argument; the lead's own `exit_plan_mode` is a different tool that reads the plan file and asks you to leave plan mode). The plan is mailed to the lead (a `plan_request` in the lead's mailbox), shown to the lead's conversation as a row, and put to you in the same box as a question, titled `writer sent a plan for approval`, with the plan as its text and two answers: yes, or no with what to change. The tool declares that every call needs a person's yes, so it is asked in every mode, with the lead's own "approve all" and auto modes included; it is never approved by a mode, a rule, a remembered answer or another member's words, and the answer is offered once and not remembered. The teammate waits for it. Yes starts it on the plan; no sends your words back to it as the reason, and it revises. Approving a teammate's plan does not change the lead's permission mode. The answer is recorded in the teammate's mailbox (`plan_response`, or `permission_response` for any other ask), together with the ids of the calls it covers.

A teammate's question outlives the lead's turn. If the lead finishes its turn while a teammate is waiting on you, the question stays on screen until you answer it; only the questions of the lead's own conversation are closed when its turn ends. (Ctrl+C at a question still rejects every open one.)

## Hook events

Three hook events are fired for the lead's team, on the lead's session, and the task events carry the member that caused them. All are described in [Hook events](../sdk/hooks.md#teammates).

- `teammate_idle` runs when a teammate's turn has ended, before the lead hears it is idle. A hook that exits `2` sends its stderr to the teammate as feedback and the teammate keeps working; a hook that refuses every time is overridden after `limits.maxHookRefusals` (8) times in a row and the lead is told.
- `teammate_start` and `teammate_stop` run when a teammate starts and when it leaves the team.
- `task_created` and `task_completed` carry `teammate_name` and `team_name` when a teammate made or completed the task.

All of them carry `teammate_name` and `team_name`; the matcher of the three teammate events is read against the name.

## The team on the terminal

With teammates on, each teammate is a row of the agents rail under the prompt, after `main`:

```
  ● main
  ◯ writer      write the parser                    working
  ◯ checker     test the parser                     waiting for you
  ◯ docs                                            idle · 12s
```

The name comes first, in the teammate's own colour, then the task it holds (the one in progress under its name), then its state: `working`, `waiting for you` (it asked a question that is open in your box), `awaiting approval` (it sent a plan and you have not answered), `idle` with how long ago, or `stopped`. A teammate stays on the rail while it is on the team, not only while a turn runs. The keys are the rail's own: Down from an empty box enters it, Up and Down select, Enter opens the teammate's transcript in the main view, Esc goes back to the lead, and Up from the first row returns to the box. The key line reads `↑/↓ to select · enter to view · x to stop · esc to collapse` (`enter to expand` on the folded row). With more than one agent running and a key line at least 90 columns wide it ends with `ctrl+x ctrl+k to stop all agents`: the chord the rest of the rail uses (press `ctrl+x`, then `ctrl+k`, and confirm with the same chord within three seconds). It is two keys that the box does not read as text, so it never clashes with what you are typing. It stops the agents that are running; a teammate between turns is not stopped by it, and the hint is left off a narrow line.

- **Colours.** Eight colours (red, blue, green, yellow, magenta, orange, pink, cyan) are handed out in the order teammates join, the lead's own first, and each teammate keeps its colour while it is on the team. The name wears it on its rail row, in every row below, on a task it holds in the task list, in the sender label of mail in a teammate's transcript, and on the prompt while that transcript is open. A name the team never gave a colour (mail from a teammate that already left) is drawn blue or pink by a hash of the name, the same every time.
- **Talking to a teammate.** While its transcript is open, what you type goes to that teammate. It reads it as a message from the person ("typed while they watch your conversation"), never as mail from another session. The prompt shows `@writer` in its colour (cut at 24 cells) in place of the `❯` mark. The transcript is a conversation: what you or the lead wrote reads as a plain `❯` row, a message from another teammate reads `← @checker: ...` in that teammate's colour, and the system prompt, the tool descriptions and the framed text the model was given are not shown. A dim line under it says what Esc does (see Stopping). A task the lead handed over is a box titled `Task #2 assigned by lead` with the subject in bold and what it asks dim, a request to stop is a warning box `Shutdown request from lead` with `Reason: ...`, and while one of its calls waits on you the end of its transcript carries a warning box, `Waiting for team lead approval`, with dim `Tool` and `Action` rows (the command, file or address) and `The request was sent to the team lead.`; after it sends a plan the box reads `Plan submitted for team lead approval` and `Waiting for team lead approval…`. The approval box shows only while no permission dialog owns the screen; while a dialog is up the opened teammate view is hidden, and the dialog itself is the place to answer.
- **Stopping.** `x` on a teammate's row asks once on the key line (`x again to stop writer`); a second `x` within three seconds stops it. `/team stop <name>` stops it without the question. A stopped row stays 30 seconds, then `x` or the time clears it. In a teammate's transcript Esc depends on what the teammate is doing. While it works, the key line says `esc to interrupt` and Esc cuts its current turn short without stopping it or taking it off the team: it goes idle (the lead's line reads `was interrupted`) and takes mail and tasks again, and the transcript stays open. When it is idle, waiting on you, or stopped, the key line says `esc to return to team lead` and Esc goes back to the lead. Esc never stops a member; `x` does.
- **Idle rows.** After the whole rail has been idle for 30 seconds (nobody on the team works and no other agent runs) the idle rows leave. Before that, up to three idle teammates keep a row each; more than three are one dim row, `4 idle agents` (the teammate that is open is not counted, it has its own row), which is a stop of the rail: select it and press Enter and every idle teammate gets a row of its own (the folded row comes back when no teammate is idle). The 30-second rule applies to both forms. With more than five rows the rail shows five and says `↑ 2 more` on the `main` row and `↓ 2 more` under the last. `/team` lists every member whether or not it has a row.
- **The task list.** `Ctrl+T` toggles the checklist as before; with a team it shows the team's list, from the shared store, headed `3/5 tasks done · 1 in progress`: every task, lowest id first, with `(@writer)` in the owner's colour after the subject and `› blocked by #1` for what it waits on. A finished task is struck through and dim. On a terminal of eleven rows or more it shows as many rows as the screen leaves (the rows minus 14, between three and five): the ones in progress first, then open ones, then the latest finished, and one line `7 tasks (1 in progress, 3 open, 3 done)` for all of them; on a terminal of ten rows or fewer it is that one line. `/team tasks` lists all of them.
- **Lines in the conversation.** The lead's conversation reads the team in a few kinds of line, each with the teammate's name in its colour.
  - A message from a teammate is one dim line, `› Message from @writer (ctrl+o to expand)`; several in a row from one teammate are `› 3 messages from @writer`. Ctrl+O opens each as `@ writer ❯ summary` and its text indented two. Mail between two teammates is not shown in the lead's conversation.
  - What the lead sent: `→ Sent to @writer` (the text behind Ctrl+O), `→ Task assigned to @writer · write the parser` (the subject only, never the instruction text), `→ Asked @writer to stop`. The `send_message` call itself leaves no row of its own, so the receipt the model reads (`Message sent to teammate ...`) is not printed.
  - A teammate that finished a turn: `● Teammate @writer finished` (`was interrupted`, `failed`; the glyph and words are green, yellow or red by the reason), and under it, dim, the first line of its answer; Ctrl+O opens the whole answer with `(task #2)` above it, and `Last message: <summary>` when the teammate sent the lead a message during that turn.
  - A task a teammate completed: `✓ @writer completed task #2 (write the parser)`, dim.
  - A teammate that approved a shutdown: `● Teammate @writer shut down`, dim (`3 teammates shut down` when several do in a row). One that refused is a grey box: `Shutdown refused by @writer`, `Reason: ...`, and dim `Still working. Ask again later.`
  - A plan is a box. When a teammate sends one, a box in the plan colour, titled `Plan approval request from @writer`, holds the plan as text (headings and `**bold**` drawn) and, when there is a plan file, a dim `Plan file: ...`. Your answer is a green box `✓ Plan approved by @writer` or a red one `✗ Plan rejected by @writer`, each with `Feedback: ...` when you gave some, and the rejection ends with a dim line to revise the plan and send it again.
  - **Boxes.** A box is a rounded border in the colour of its kind with a bold title, body lines, and dim footnote lines; it is as wide as its longest line and never wider than the screen, and long lines wrap inside it. Under 40 columns a box has no border and reads as an indented block; where the terminal draws no colour (`NO_COLOR`, `FORCE_COLOR=0`, a dumb terminal) the border and title keep the terminal's own colour.
  - Messages in one short moment (a quarter of a second) fold into one line; a sub-agent's correction still reads "correction sent". A turn of the lead that only kept the task list or the mail no longer ends with "A command ran that may have changed files".

`/team` writes each member with its state and task and the task counts; `/team tasks` writes every task as `#2 □ test it › blocked by #1` (a task is numbered by its place in the list, lowest id first, whatever its id is); `/team stop <name>` stops one. In a conversation with teammates off, `/team` says so in one line. Teams on the terminal need no setting of their own.

## The task list

With teammates on, the lead's task tools work from the team's list, `<NAMZU_HOME>/tasks/team-<id>/`, and so do all the teammates' tools, each under its own name (`lead` for the lead). `task_update` to `in_progress` claims, one member's task is not closed by another, and `task_get` reads one in full. The list stays after the team ends. See [Teams (SDK)](../sdk/teams.md#the-shared-task-list).

## Limits

| Setting | Default | Range | Meaning |
| --- | --- | --- | --- |
| `teams.enabled` | `false` | true or false | Whether a named `Agent` call starts a teammate. |
| `teams.maxTeammates` | `5` | 1 to 16 | Most teammates alive at once in one conversation. |
| `teams.idleExitMinutes` | `30` | 1 to 1440 | Minutes a teammate with nothing to do waits before it ends. |
| `teams.shutdownGraceSeconds` | `20` | 1 to 600 | Seconds a teammate has to answer a shutdown request before it is stopped. |

The files a team keeps are described in [Teams (SDK)](../sdk/teams.md).
