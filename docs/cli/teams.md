---
type: Guide
title: Teammates
description: How teammates are turned on (the teams.enabled setting, NAMZU_TEAMS and --teams), how a named Agent call starts one and how it runs, the shared task list and mail, the limits that apply, and where they do not run.
resource: packages/cli/src/integrations/teams/
tags: [cli, teams, teammates, settings, experimental]
status: draft
generated: { by: "claude-sonnet-5", at: "2026-11-24" }
---

# Teammates

A teammate is a named helper that keeps its own conversation beside the main one, can message the other teammates, and shares a task list with them. In a conversation where teammates are on, the `Agent` tool given a `name` starts a teammate; without a name, or with teammates off, it starts a plain sub-agent exactly as before. This page covers the switch, how a teammate runs, and the limits. The shutdown protocol, permission and plan routing, the team panel and the `namzu team` command are later steps.

## Turning them on

Off by default. Any one of these turns them on:

- the setting `teams.enabled` (Settings, Helpers and workflows, *Teammates*; or `namzu config set teams.enabled true`),
- `NAMZU_TEAMS=1` in the environment,
- `namzu --teams` for one launch (a settings layer that wins over your files and loses to the managed file).

`NAMZU_TEAMS=0` (also `off`, `false`, `no`) is a hard stop that wins over all three. Teammates never run in a headless run (`exec`, print mode, a schedule, `serve`, a Pal), whatever is set. The answer is read again at every named `Agent` call, so a change takes effect on the next call without a restart; teammates already running are not stopped by it.

These settings are your own config file's and the managed file's. A repository's `.namzu/config.yaml` cannot set them: a project must not start helpers that spend your limit.

## How a teammate runs

The first named `Agent` call creates the team of the conversation, `team-` and the last eight characters of the lead session's id (the start of that id is the same for every session of the same weeks, so the end is the part that tells sessions apart). The call reserves the name in the team's file, starts the teammate and returns at once; if starting fails the name is given back. A name must pass the same rule as a team member's name in the SDK (`lead`, `main`, `team-lead`, `user`, `system` and id-shaped names are refused). `workspace: "worktree"` and the `fork` type are refused for a teammate for now: a teammate has to be woken for more work, and it shares the lead's checkout, so give teammates files that do not overlap.

A teammate runs inside the lead's process, as a child session with its own history and its own stop. It receives the brief you gave plus a short note: plain text is seen by nobody, so it must call `send_message`, and the task tools are its way to the shared list. It runs under its own turn of the conversation, so it outlives the turn that started it; its permission asks go to the review channel the person last used (a routing of asks that names the teammate is a later step). Its model is the one the call named, else the session's.

When a teammate's turn ends it does not end. It goes **idle**: the lead hears it like any background agent finishing, and the team keeps one idle line in the lead's mailbox. An idle teammate wakes when

- mail arrives for it (a `send_message` from the lead or another teammate, written to its mailbox and handed over at once),
- a task nobody owns, that is pending and not waiting on another, appears in the team's list: it takes the lowest one, claims it under its name and works on it, or
- the next look at the list, every five seconds, finds one that another process added.

A teammate whose last turn failed waits for mail instead of taking another task, so a failure does not repeat on its own. After `teams.idleExitMinutes` with nothing to do it ends and gives its place back; a message to it later resumes it from its saved conversation (if the team is under `teams.maxTeammates` again). At most 8 messages from one member to another in a minute are accepted, so two cannot answer each other without end. When the lead's conversation closes every teammate is stopped and the team's directory is removed; the task list and the transcripts stay.

Mail is always labelled to the receiver as coming from another session in the team, never from the person: it cannot approve anything for the receiver or grant permission, and what it says is not proof of anything. A teammate's message to the lead reaches the lead's conversation as "Teammate <name> (another session in your team, not the person)". Teams are not resumable: a lead that is resumed does not restart its teammates.

## The task list

With teammates on, the lead's task tools work from the team's list, `<NAMZU_HOME>/tasks/team-<id>/`, and so do all the teammates' tools, each under its own name (`lead` for the lead). `task_update` to `in_progress` claims, one member's task is not closed by another, and `task_get` reads one in full. The list stays after the team ends. See [Teams (SDK)](../sdk/teams.md#the-shared-task-list).

## Limits

| Setting | Default | Range | Meaning |
| --- | --- | --- | --- |
| `teams.enabled` | `false` | true or false | Whether a named `Agent` call starts a teammate. |
| `teams.maxTeammates` | `5` | 1 to 16 | Most teammates alive at once in one conversation. |
| `teams.idleExitMinutes` | `30` | 1 to 1440 | Minutes a teammate with nothing to do waits before it ends. |

The files a team keeps are described in [Teams (SDK)](../sdk/teams.md).
