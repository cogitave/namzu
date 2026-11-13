---
type: Reference
title: namzu plugin validate
description: Check a plugin folder and every part it carries without running anything from it - the problems it reports, their codes, the JSON shape and the exit statuses.
resource: packages/cli/src/commands/plugin.ts
tags: [cli, plugins, validation, json]
---

# namzu plugin validate

```bash
namzu plugin validate [--json] [--] [path]
```

Checks the plugin in `path` (the current folder when none is given) and says
what the loader would do with each part of it. It is the place to learn that a
skill will not load, a command file is ignored or a hook names an event that
does not exist, before the plugin is shared or enabled, instead of from a log
line at startup.

It lives under `namzu plugin`, beside the `/plugins` menu, because it is about
a plugin folder and not about the session; `namzu skills --audit` stays where it
is for skills found in your own folders.

## What it never does

It runs nothing from the plugin. No hook is called, no MCP server is started, no
command or script is run, no module is imported and no network request is made.
It reads files inside the plugin folder, one at a time, as text. A reference
that leaves the folder (`..`, an absolute path, a link whose target is outside)
is reported and never followed: the target is not opened and nothing from it
appears in the report.

Reading is bounded. A file larger than 4 MiB is not read (the loader reads any
size, so for a skill, a command, a tool or hook module and the manifest this is
a warning, "not read", not a claim that the loader refuses it; a manifest that
is not read leaves the rest of the plugin unchecked), and a file with a zero
byte in it is reported as not text. A declared folder of commands or agents is
checked for its first 500 markdown files; a folder with more gets a warning
saying so, and exit status 10 then does not vouch for the files after the 500th.

What this costs: a tool or hook module's exports are only known by running it,
so a module is checked for being a readable file inside the folder and, as a
warning, by what its text says (no mention of the `tools` or `hooks` export; a
hook event name that Namzu does not have). Whether the module really loads is
decided when it is imported, which this command does not do.

## One set of rules

The command applies the loader's own functions to the text it reads. The
manifest goes through the same parser and the same enablement check as at
startup; a skill through the skill reader; an agent file through the agent file
reader; a command file through the command file reader; a declared folder and a
path through the containment rules the session uses. A test loads each fixture
plugin with the loader and with this command and requires the parts the loader
accepts to be exactly the parts this command reports no error for. The two
place the loader's answer cannot be reproduced without running code (a module's
exports) is named in that test.

## Levels

- **error**: the loader refuses the plugin or skips a part. A plugin with an error does not
  load as written.
- **warning**: it loads, and is very likely not what you meant: an unknown key
  that is ignored, a skill description large enough to crowd the others out of
  the model's list, a reference to a file outside the folder, a hook event that
  does not exist, a name written twice.

Each problem carries the file (relative to the plugin folder), the line when the
file says where, a sentence for what is wrong, and a sentence for what the
loader does about it.

When the manifest itself is refused, the parts it declares cannot be listed and
only the manifest is reported. When it is readable but cannot be enabled here
(a `platforms` or `engines.namzu` that does not fit, or `connectors` or
`personas`), the parts are still checked, so everything shows in one run.

## Exit status

| Status | Meaning |
|---|---|
| `0` | No problems. |
| `10` | Warnings only. |
| `1` | At least one error. |
| `66` | The folder could not be read (it does not exist, is not a folder, or cannot be opened). |
| `64` | The command line is wrong (no subcommand, an unknown option, more than one folder). The reason is on standard error. |

## `--json`

`--json` prints one JSON document on standard output and nothing else, and the
same exit status. Messages about a wrong command line go to standard error.

```json
{
  "version": 1,
  "folder": "/work/ledger",
  "status": "warnings",
  "plugin": { "name": "ledger", "version": "1.0.0" },
  "parts": [
    { "kind": "manifest", "name": "plugin.json", "file": "plugin.json", "status": "ok" },
    { "kind": "skill", "name": "skills/reconcile", "file": "skills/reconcile", "status": "warning" }
  ],
  "problems": [
    {
      "level": "warning",
      "part": "skill:skills/reconcile",
      "file": "skills/reconcile/SKILL.md",
      "line": 4,
      "code": "skill-unknown-key",
      "message": "\"allowed_tools\" is not a key a skill reads, so it is ignored. If it is a misspelling, what it was meant to set is not set.",
      "consequence": "The loader drops the key without a word."
    }
  ],
  "summary": { "errors": 0, "warnings": 1 }
}
```

- `version` is the version of this shape. Fields are added, not renamed or
  removed, within a version.
- `folder` is the absolute folder checked.
- `status` is `clean`, `warnings`, `errors` or `unreadable`. With `unreadable`
  the report has a `readError` string and empty `parts` and `problems`.
- `plugin` has `name` and `version` when the manifest is readable enough to say
  them, and is `{}` otherwise.
- `parts` lists what was found. `kind` is `manifest`, `tool`, `hook`, `skill`,
  `mcp-server`, `command` or `agent`; `name` is the path for a tool, hook or
  skill, the server name, `<plugin>__<file>` for a command and
  `<plugin>__<name>` for an agent. `status` is `ok`, `warning` or `error`.
- Each problem has `level`, `part` (`<kind>:<name>`, or `manifest`), `file`,
  `line` (absent when unknown), `code`, `message` and `consequence`.

### Problem codes

| Code | Level | Meaning |
|---|---|---|
| `manifest-missing`, `manifest-not-regular`, `manifest-unreadable`, `manifest-too-large`, `manifest-binary`, `manifest-json` | error | `plugin.json` is absent, is a link or folder, cannot be read, is not text, or is not JSON. |
| `manifest-schema` | error | A field is missing, the wrong type, out of range, or not accepted (an MCP server with `url`). |
| `manifest-incompatible` | error | The plugin cannot be enabled here: `platforms`, `engines.namzu`, or `connectors` / `personas`. |
| `manifest-too-large` | warning | `plugin.json` is over 4 MiB and was not read, so nothing else was checked; the loader reads any size. |
| `manifest-unknown-key`, `manifest-version-format`, `manifest-empty` | warning | An ignored field, a version that is not `1.2.3`, a plugin that declares nothing. |
| `path-missing`, `path-outside`, `path-not-file`, `file-unreadable`, `file-binary` | error | A declared path does not exist, leaves the folder, is not a regular file, cannot be read, or is not text. (`path-outside` is a warning for a `SKILL.md` that is a link to a file outside: the loader reads through it, this command does not.) |
| `file-too-large` | warning, error for an agent file | A file over 4 MiB was not read; the loader refuses a larger agent file and reads the others. |
| `skill-invalid`, `skill-duplicate` | error | The skill reader refuses `SKILL.md` (name, description, `invocation`, frontmatter), or two skills share a name. |
| `skill-unknown-key`, `skill-description-large`, `skill-body-empty` | warning | An ignored frontmatter key, a description that uses more than a quarter of the model's skill list, no instructions. |
| `command-invalid` | error | The command file does not parse. |
| `command-unknown-key`, `command-empty`, `command-name`, `command-duplicate`, `file-ignored` | warning | An ignored key (`allowed-tools`, for one), an empty prompt, a name with a space, a name written in two folders, a link or folder named `.md`, or a file named `.MD`, `.markdown`, `.mdown`, `.mkd` or `.mdx`, that is passed over (only names ending in lowercase `.md` are read). |
| `agent-invalid` | error | The agent file is skipped (no name, a reserved name, no description, a bad list or mode, an empty body). |
| `agent-unknown-key`, `agent-duplicate` | warning | An ignored key (a misspelt `tools:` leaves the agent with every tool), a name written twice. |
| `module-extension`, `module-export`, `hook-event-unknown`, `part-duplicate` | warning | A tool or hook module that does not end in `.js`, `.mjs` or `.cjs`, whose text never mentions its export, a hook event Namzu does not have (or one that was renamed), a module listed twice. Found by reading the text. |
| `hook-entries-outside`, `hook-entries-missing`, `hook-entries-unreadable`, `hook-entries-json`, `hook-entries-shape`, `hook-entries-invalid` | error | Hook entries (a command, an address or a prompt) the plugin ships that are not loaded: a `.json` path in `hooks` that leaves the plugin folder, a listed file that does not exist or is not a regular file or is too large, a file that is not JSON or not an object of events, an event Namzu does not have, a hook kind it does not have or an entry it cannot read. The plugin itself still loads; those entries are not attached, so what they were meant to guard is not checked. Read from `hooks/hooks.json`, each `.json` path in `hooks` and `hookEntries`, by the reader a config file's `hooks` key goes through. |
| `hook-entries-note` | warning | A key beside `hooks` in a hooks file, or a setting of an entry that is read but not acted on. |
| `mcp-command-outside`, `mcp-arg-outside`, `mcp-duplicate-server` | warning | An MCP server command or argument that points outside the folder, two servers with one name. Never started or looked at. |
| `entries-truncated` | warning | A folder held more than 500 markdown files. |

New codes may be added within version 1.

## When a plugin part is skipped at startup

A plugin folder or file that the session skips, or a plugin that is refused at
startup, says in one line to run `namzu plugin validate`, with the plugin's folder
when the message knows it: on the error shown when plugins could not load, on the
warning line in the log for a declared command or agent folder that was refused
or missing, a plugin that was skipped, and a plugin agent file that was skipped,
and after the reason a plugin command shows when it cannot be used (in the
command list and when it is run). Messages that have no such place (the quiet
passes over a link named `.md`) are unchanged.
