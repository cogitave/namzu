---
type: Guide
title: namzu config
description: List, read, set and unset any described setting from the terminal or with /config <key>, through the same description, checks and confirmations as Desktop Settings.
resource: packages/cli/src/commands/config.ts
tags: [cli, config, settings]
generated:
  by: namzu/settings-one-source
  at: 2026-11-18
---

# namzu config

`namzu config` reads and changes the settings that [Desktop Settings](desktop-settings.md) shows, in the
user config file (`$NAMZU_HOME/config.yaml`). It does not list settings itself: it reads the engine's
[setting description](setting-description.md), so a setting added there appears in Desktop, in
`namzu config list` and in `/config <key>` with no second edit.

```
namzu config list [--section <name>] [--json]
namzu config get <key> [--json]
namzu config set <key> <value> [--yes]
namzu config unset <key> [--yes]        (also: reset)
```

- `list` prints every setting on one line: key, plain label, the value in the user file (or `default`),
  the default in words and when a change applies. Settings are listed by section, and inside a section
  a heading names each group (`Terminal app`, `Command line`) over its rows; `--json` carries the same
  as `group` and `groupLabel` on a row that has one (the Command line heading appears in two sections: under `terminal` over `format`, `quiet` and
  `profiles`, and under `updates` over the three `updates.*` settings). `--json` gives the same as data (`default` and `control`
  are the typed default and range Desktop reads). A setting that holds secrets or runs commands is never
  printed: it says to edit the config file.
- `get` shows one setting: value, default, range or choices (value and plain label), what a change asks,
  when it applies, and the file. An unknown key says so and names the closest keys.
- `set` reads the text by what the setting is: `on`/`off`/`true`/`false`; a number (a time takes `5m`,
  `90s`, `1h 30m`, a bare number is minutes; a size takes `200k` or `1m`); a choice by its value or its
  plain label, in any case; a comma list; text as typed; JSON for a table (see
  [Lists and maps](#lists-and-maps)). The value then goes through the
  same checks as Desktop's write, so a value Desktop refuses is refused with the same sentence: more
  helpers at once than 16, `model: auto` without `routing.default`, a bad browser profile name, text where
  a number goes.
- `unset` is Desktop's Use default: it removes the key from the user file.

Only the user file is written, never a project file.

## Lists and maps

A setting that holds a list or a small map takes the same words as its Desktop control. `namzu config get`
prints what it takes.

```
namzu config set tui.notifications on                       # turn-settled and approval-required
namzu config set tui.notifications turn-settled,idle-prompt # only those events
namzu config set tui.notifications off                      # false
namzu config set tui.workspacesPrefix ctrl+g
namzu config set composerTriggers.builtin hypermode=suggest,max-effort=arm
namzu config set composerTriggers.builtin '{"schedule":"off"}'
namzu config set toolResultScreens injection,correspondence
namzu config set toolResultScreens '[{"name":"correspondence","passthroughTools":["web_search"]}]'
namzu config set toolResultScreens none                     # screening off
namzu config set telemetry.sessionExport.eventTypes turn_completed,message_added
namzu config set telemetry.sessionExport.eventTypes all     # removes the key
namzu config set telemetry.sessionExport.redactors off      # asks first
namzu config set additionalDirectories /data/a,/data/b      # asks when a folder is added
namzu config set additionalDirectories none                 # removes the key
namzu config set skills.disabled review-changes,browser-automation
namzu config set skills.disabled '["a-skill-called-none"]'
```

- A **list** is a comma list of values or labels, `none` for an empty one (a folder or a skill that is itself
  called `none` is written as JSON), or JSON. An empty list for a setting whose default is none (`additionalDirectories`,
  `skills.disabled`) removes the key. A switch with events
  (`tui.notifications`) also takes `on` and `off`; a switch saved as a list (`redactors`) takes `on` and `off`.
- A **map** (`composerTriggers.builtin`) is `entry=level` words, comma separated, or JSON. Words change only the
  entries they name; the others keep the level they hold now (JSON, or `off`, replaces the whole map). An entry set to
  its default is left out of the file and the key goes when none is left, as in Desktop.
- A name that holds a comma (a folder such as `/data/a,b`) is split by the comma list; write it as a JSON list. When a
  list would add a folder (`additionalDirectories`), the question names what is added, so a wrong split shows.
- `mcpServers` stays a file-only setting here; `namzu mcp add|remove` changes the user file's servers.
- A value that means the same as no key (every event, the default screen alone) removes the key.
- A key the loader refuses is refused in the loader's words: `tui.workspacesPrefix ctrl+c` says it must be
  ctrl+ and a letter, or ctrl+space, not ctrl+c, ctrl+d, ctrl+z or the keys of Tab, Enter, Backspace and Escape.

## Settings that ask first

A setting whose description carries a confirm sentence asks as Desktop does: only for the risky choice
(`permissions.defaultMode` bypass, accept-edits or auto), a switch in the risky direction, a cap set to 0,
or a clear whose default is risky. On a terminal it asks `y/N` with that sentence. Without a terminal it is
refused unless `--yes` is given; the refusal prints the sentence and the command to run again. Saving the
value already saved asks nothing.

## In the terminal app

`/config <key>` shows the same as `namzu config get <key>`, `/config <key> <value>` sets it, and
`/config <key> unset` clears it. A setting that asks opens a yes/no choice with the same sentence. The older
subcommands (`sources`, `limits`, `triggers`, `theme`, `motion`, `recap`, `tips`) keep their meaning and win
over a key of the same name.

## Exit codes

`0` done, `1` refused or failed, `64` a usage mistake (unknown command or section, missing argument), as in the other commands.
The retry hint a refused risky change prints quotes the value so it can be pasted.

## Keeping the terminal and Desktop alike

Desktop's number box and this command read numbers with two copies of one parser
(`desktop/src/renderer/config-settings-model.ts` and `cli/src/config/setting-values.ts`), and the list and
map controls choose the value to save with two copies of one set of functions
(`desktop/src/shared/config-settings-values.ts` and `cli/src/config/setting-values.ts`), because neither
package can import the other. `config-settings-terminal-parity.test.ts` in Desktop feeds one table of
inputs to both (the number parsers and the list and map functions) and fails when they differ.
