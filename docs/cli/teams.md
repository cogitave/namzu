---
type: Guide
title: Teammates
description: How teammates are turned on (the teams.enabled setting, NAMZU_TEAMS and --teams), the limits that apply, and where they do not run.
resource: packages/cli/src/integrations/teams/
tags: [cli, teams, teammates, settings, experimental]
status: draft
generated: { by: "claude-sonnet-5", at: "2026-11-24" }
---

# Teammates

A teammate is a named helper that keeps its own conversation beside the main one, can message the other teammates, and (in a later step) shares a task list with them. In a conversation where teammates are on, the `Agent` tool given a `name` starts a teammate; without a name it starts a plain sub-agent as before. This page covers the switch and the limits. The runner, messaging and task list arrive in later steps; until then, turning teammates on changes nothing a person can see.

## Turning them on

Off by default. Any one of these turns them on:

- the setting `teams.enabled` (Settings, Helpers and workflows, *Teammates*; or `namzu config set teams.enabled true`),
- `NAMZU_TEAMS=1` in the environment,
- `namzu --teams` for one launch (a settings layer that wins over your files and loses to the managed file).

`NAMZU_TEAMS=0` (also `off`, `false`, `no`) is a hard stop that wins over all three. Teammates never run in a headless run (`exec`, print mode, a schedule, `serve`, a Pal), whatever is set. The answer is read again at every named `Agent` call, so a change takes effect on the next call without a restart; teammates already running are not stopped by it.

These settings are your own config file's and the managed file's. A repository's `.namzu/config.yaml` cannot set them: a project must not start helpers that spend your limit.

## Limits

| Setting | Default | Range | Meaning |
| --- | --- | --- | --- |
| `teams.enabled` | `false` | true or false | Whether a named `Agent` call starts a teammate. |
| `teams.maxTeammates` | `5` | 1 to 16 | Most teammates alive at once in one conversation. |
| `teams.idleExitMinutes` | `30` | 1 to 1440 | Minutes a teammate with nothing to do waits before it ends. |

The files a team keeps are described in [Teams (SDK)](../sdk/teams.md).
