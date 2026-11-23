---
type: Reference
title: Command words and help
description: How Namzu commands are spelled (namzu area action target, words apart), namzu help, help that works before the Namzu home exists, and the spellings that were retired with what to type instead.
resource: packages/cli/src/cli.ts
tags: [cli, commands, help, grammar]
status: stable
generated: { by: process:claude-code, at: 2026-11-23T00:00:00Z }
---

# Command words and help

A command is `namzu <area> <action> [target] [--option value]`. Words are
separated by spaces, there are no hyphenated subcommands and no second names
for a command, and an option keeps its `--name` form.

## namzu help

`namzu help` prints the same text as `namzu --help`. `namzu help <command>
[action...]` prints exactly what `namzu <command> [action...] --help` prints:

```bash
namzu help exec
namzu help config set
namzu help computer stop idle
```

A name after `namzu help` that is not a command gets `Unknown command '<name>'.`, exit 64. Typed on its own, a word that is not a command (`namzu fix`) is the first message of a new session, not an error. `--yolo` is refused with its one line on every command.

## Help for one action

A command with actions answers `namzu <area> <action> --help`, and `namzu help <area> <action>`, with that action's own help: a first line that is its usage (`namzu schedule add <name> [options]`), one sentence on what it does, its options with a line each, and one example. `namzu <area> --help` is the area's text followed by an **Actions** list with one line per action and `namzu <area> <action> --help for details.` A group word (`namzu schedule service --help`, `namzu extension signin --help`) lists the actions under it. Words that name no action fall back to the area's help.

The areas that have actions are `schedule` (and `schedule service`), `extension`, `browser`, `mcp`, `auth`, `state`, `computer`, `config`, `skills`, `providers`, `worktree`, `pal`, `peers`, `plugin`, `github` and `archive`. `learn`, `learning`, `hooks` and `workspaces` take options only, so their one help is the whole of it.

Each area declares its actions in one table (`packages/cli/src/commands/actions/`), and a test reads every declared flag against the source of the parser that accepts it, so a flag the parser does not read cannot be listed.

## Help without a Namzu home

`namzu --help`, `-h`, `--version`, `-V` and `namzu help ...` print their text
and exit 0 when the Namzu home does not exist. So does `--help` after any
command (`namzu exec --help`). They never create the folder. A `NAMZU_HOME`
that names a folder that is not there stops a command that needs the home, and
is ignored by a request for help.

## Retired spellings

A retired spelling prints one line naming the new one, exits 64 and does
nothing else.

| Typed | Now |
|---|---|
| `namzu spaces` | `namzu workspaces` |
| `namzu e "<prompt>"` | `namzu exec "<prompt>"` |
| `namzu config reset <key>` | `namzu config unset <key>` |
| `--yolo` | `--dangerously-skip-permissions` |
| `namzu upgrade` | `namzu update` |
| `namzu login <provider>` | `namzu auth login <provider>` |
| `namzu logout` | `namzu auth logout` |
| `namzu run`, `namzu run-stream` | `namzu exec`, `namzu exec --json` |
| `namzu skills-json`, `namzu providers-json` | `namzu skills list --json`, `namzu providers list --json` |

`namzu computer stop-idle` is now `namzu computer stop idle`. The hyphenated
form still works and is left out of the help, because Namzu Desktop builds that
are already installed run it.
