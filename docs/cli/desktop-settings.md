---
type: Guide
title: Desktop settings for config keys
description: How every Namzu config key reaches Desktop Settings from one engine-owned list, what Desktop writes, what it never shows, and which changes it asks about first.
resource: packages/cli/src/config/settings-descriptors.ts
tags: [cli, desktop, config, settings]
generated:
  by: namzu/desktop-settings-parity
  at: 2026-11-10
---

# Desktop settings for config keys

Desktop Settings shows the keys of the user config file (`$NAMZU_HOME/config.yaml`) next to its own
preferences. Desktop does not know the keys. The engine describes them and Desktop draws what it is told.

## One list

Each descriptor also carries a typed default, plain-worded choices and an apply time: see [The setting description](setting-description.md).

`packages/cli/src/config/settings-descriptors.ts` holds one descriptor per setting: its path, label,
one-line description, section, control (switch, choice, checkboxes, number, text, JSON, or file only),
default in words, and, for a risky one, the sentence the confirmation shows. The engine answers
`namzu/config/get` with the list and the saved values, and `namzu/config/set` with a change.

`desktop-settings.test.ts` fails when a top-level key the loader reads (`CONFIG_KEYS`, exported from
`config/load.ts`) has neither a descriptor nor an entry in `SETTING_EXCLUSIONS` with a reason. A new key
therefore cannot reach the loader without a decision about Desktop.

## Sections

General, Models and Projects keep their own rows and add the engine's below them under
**Namzu settings**. **Agent** (limits, workflows, compaction, memory, learning, skills, schedule,
hypermode), **Tools** (web, browser and its switch, code analysis, servers, hooks, plugins),
**Telemetry** and **Terminal** are made of the engine's rows. **Desktop app** holds only the app's own.

A row sits where its effect is, so the engine can name a heading inside a section. A descriptor's
optional `group` is one of `terminal-app` or `command-line` (`SettingGroup`), and
`SETTING_GROUP_LABELS` in `settings-descriptors.ts` is the only place the words live: the engine sends
`group` with `groupLabel` and Desktop draws the heading it is given, rows with no group first. An
engine older than the field sends neither, and Desktop draws its rows with no heading.

- Terminal: **Terminal app** (`tui.*`, `statusLine`, `composerTriggers.*`) and **Command line** (`format`,
  `quiet`, `profiles`). The app's own **Terminal tabs** rows come first.
- Updates: the app's own rows, then **Command line** (`updates.channel`, `updates.auto`, `updates.check`).
- Tools: `browser.enabled` and `codeAnalysis.enabled`, which a Desktop conversation honours as well as
  the terminal app.

Search finds every one, and a hit lands in the section that draws the row.

## What a write does

- Only the user file is written, through `setUserConfigValue` and `deleteUserConfigValue` (private mode,
  atomic rename, refuses a file that is not valid YAML). Project and local config files are the
  repository's and Desktop never writes them.
- Before writing, the value is checked against its control and then the loader's own reader for the whole
  top-level block, so a write cannot make the next launch fail. The loader's sentence is shown under the field.
- **Use default** removes the key.
- Desktop main asks first for a setting whose descriptor carries a `confirm` sentence (permissions,
  sandbox, extra folders, plugins, web access, anything that sends text out or removes a check): the
  in-app dialog, with a one-time token bound to that window and that exact change. `confirmWhen`
  (`on`, `off`, `zero`) narrows it to the direction that widens, so turning a sandbox on does not warn
  about having none; **Use default** on a confirmed setting always asks. The engine checks the value
  first (`dryRun` on `namzu/config/set`), so a refused value never shows a dialog. `namzu/config/get`
  and `set` both refuse a Pal.
- A running conversation may keep the values it started with; a new one reads the saved file.

## What is never shown

`mcpServers`, `hooks`, `decision`, `statusLine`, `profiles` and `telemetry.otlp.headers` hold commands or
secrets. Their control is file only: Desktop says **Set in your config file** or **Not set** and never reads
the value out or writes it. Provider keys keep their own masked flow under Models.

## Not exposed

`permissionLayers` and `permissionSettings` are derived by the loader. `tui.spacesPrefix` is a deprecated
alias of `tui.workspacesPrefix`. Project-scope limits (for example a project cannot set `model` or
`decision`) stay in the loader; Desktop only edits the user file.
