---
type: Guide
title: Teammates
description: How teammates are turned on (the teams.enabled setting, NAMZU_TEAMS and --teams), how a named Agent call starts one and how it runs, the shared task list and mail, how a teammate's permission asks and plans reach you, its hook events, the limits that apply, and where they do not run.
resource: packages/cli/src/integrations/teams/
tags: [cli, teams, teammates, settings, experimental]
status: draft
generated: { by: "claude-sonnet-5", at: "2026-11-24" }
---

# Teammates

A teammate is a named helper that keeps its own conversation beside the main one, can message the other teammates, and shares a task list with them. In a conversation where teammates are on, the `Agent` tool given a `name` starts a teammate; without a name, or with teammates off, it starts a plain sub-agent exactly as before. This page covers the switch, how a teammate runs, how its permission asks and plans reach you, the hook events, and the limits. The team panel and the `namzu team` command are later steps.

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

## Hook events

Three hook events are fired for the lead's team, on the lead's session, and the task events carry the member that caused them. All are described in [Hook events](../sdk/hooks.md#teammates).

- `teammate_idle` runs when a teammate's turn has ended, before the lead hears it is idle. A hook that exits `2` sends its stderr to the teammate as feedback and the teammate keeps working; a hook that refuses every time is overridden after `limits.maxHookRefusals` (8) times in a row and the lead is told.
- `teammate_start` and `teammate_stop` run when a teammate starts and when it leaves the team.
- `task_created` and `task_completed` carry `teammate_name` and `team_name` when a teammate made or completed the task.

All of them carry `teammate_name` and `team_name`; the matcher of the three teammate events is read against the name.

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
