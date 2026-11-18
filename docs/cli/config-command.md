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
  the default in words and when a change applies. `--json` gives the same as data (`default` and `control`
  are the typed default and range Desktop reads). A setting that holds secrets or runs commands is never
  printed: it says to edit the config file.
- `get` shows one setting: value, default, range or choices (value and plain label), what a change asks,
  when it applies, and the file. An unknown key says so and names the closest keys.
- `set` reads the text by what the setting is: `on`/`off`/`true`/`false`; a number (a time takes `5m`,
  `90s`, `1h 30m`, a bare number is minutes; a size takes `200k` or `1m`); a choice by its value or its
  plain label, in any case; a comma list; text as typed; JSON for a table. The value then goes through the
  same checks as Desktop's write, so a value Desktop refuses is refused with the same sentence: more
  helpers at once than 16, `model: auto` without `routing.default`, a bad browser profile name, text where
  a number goes.
- `unset` is Desktop's Use default: it removes the key from the user file.

Only the user file is written, never a project file.

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

`0` done, `1` refused or failed, `2` a usage mistake (unknown command or section, missing argument).

## Keeping the terminal and Desktop alike

Desktop's number box and this command read numbers with two copies of one parser
(`desktop/src/renderer/config-settings-model.ts` and `cli/src/config/setting-values.ts`), because neither
package can import the other. `config-settings-terminal-parity.test.ts` in Desktop feeds one table of
inputs to both and fails when they differ.
