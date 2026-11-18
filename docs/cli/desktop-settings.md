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
one-line description, section, control (switch, choice, checkboxes, number, text, one of the list and map controls below, JSON, or file only),
default in words, and, for a risky one, the sentence the confirmation shows. The engine answers
`namzu/config/get` with the list and the saved values, and `namzu/config/set` with a change.

`desktop-settings.test.ts` fails when a top-level key the loader reads (`CONFIG_KEYS`, exported from
`config/load.ts`) has neither a descriptor nor an entry in `SETTING_EXCLUSIONS` with a reason. A new key
therefore cannot reach the loader without a decision about Desktop.

## List and map controls

A list, a small map or a model is a typed control, not a box of JSON. Each kind has one way to be read from
Desktop and from `namzu config set`, and one value it writes:

| Kind | Row | What it writes |
| --- | --- | --- |
| `toggle-checks` | `tui.notifications`: three event checks (none ticked is off) | `false` for off; `true` when exactly *Turn finished* and *Approval needed* are ticked (what `true` means in the loader); otherwise the list of ticked events (`turn-settled`, `approval-required`, `idle-prompt`). Unticking the last event writes `false`. *Waiting for you* (`idle-prompt`) is a notice after a minute of quiet that Namzu is still waiting for your message. |
| `key` | `tui.workspacesPrefix`: a pick | The key as the loader spells it, `ctrl+<letter>` or `ctrl+space`. The list (`PREFIX_KEYS`, from `workspaces/prefix.ts`) leaves out `ctrl+c`, `ctrl+d`, `ctrl+z` and the keys that are Tab, Enter, Backspace or Escape (and the other letters the prefix reader refuses). Default Ctrl+B. |
| `levels` | `composerTriggers.builtin`: one Arm, Suggest or Off choice for each of `hypermode`, `workflow`, `save-skill`, `schedule`, `max-effort` | A map of the triggers that differ from their default (arm, arm, arm, suggest, off). Setting a trigger to its default removes its entry; the key goes when the map is empty. |
| `screens` | `toolResultScreens`: a check for each screen the reader knows (`correspondence`, `injection`) and a list of tools the correspondence screen lets through | The list the reader takes: a screen as its name, or `{ name: correspondence, passthroughTools: [...] }` when tools are listed. Only the default (`correspondence`, no tools) removes the key; unticking every screen writes `[]` (screening off). Asks first when the new list drops the default screen. |
| `checks` with `allLabel` | `telemetry.sessionExport.eventTypes`: a check for every event type the export can carry | The ticked event types. All ticked removes the key, because a missing key means every event, new ones too. None ticked writes `[]` and the row says "Nothing will be saved." The choices are `SESSION_EXPORT_EVENT_TYPES` (`integrations/telemetry/session-export.ts`), the kernel's own list. |
| `toggle-list` | `telemetry.sessionExport.redactors`: one switch, *Hide secrets* | On writes `["secrets"]` (the default), off writes `[]` and asks first. `secrets` is the only redactor the engine installs by name. |
| `list` with `picker: folder` | `additionalDirectories` (Projects, *Extra folders*): one folder per line with Remove, and **Add folder**, which opens the system folder picker | The list of paths, as picked or typed. An empty list removes the key (none is the default). A folder that is not there is flagged on its line (`existingFolders` in the main process answers which of the listed absolute paths are folders; a relative path cannot be told from there and is not flagged). Asks only when a folder is added, never when one is removed. |
| `list` with `source: skills` | `skills.disabled` (Agent, *Turned-off skills*): every installed skill with a switch | The names of the skills switched off. Off adds the name, on takes it out, an empty list removes the key. The skills come from the engine's own discovery (`namzu/skills/list`): built-in, `~/.agents/skills`, `~/.namzu/skills` and, for a trusted project, the project's tiers; one entry per name, with its tier in words. A name in the file that no installed skill has stays listed with a note and Remove. A host without the method keeps a typed list. |
| `model` | `smallModel` (Models, *Small model*): a text box that offers the models Desktop already knows | The text as written, `provider/model` when picked from the list, or a bare model id of the provider a conversation runs on; the loader refuses a name with a space in it. Empty puts the default back. When `NAMZU_SMALL_MODEL` is set in the engine's environment the row says so, with its value, and that it is used instead of what is saved (the loader gives the variable priority over the user file; a managed file still wins over both, which the row cannot see because it reads only the user file). A variable set but blank is named, since the loader refuses it. |
| `routing` | `routing` (Models, *Automatic routing*): a form with *Default model*, *Fast model*, *Large model*, *How a task is sized* and *Time to decide* in seconds | The table the loader reads, in its order: `default: { provider, model }`, `tiers: { fast, big }`, `strategy` (`yesno` or `score`), `thresholds` and `timeoutMs`. A model written `provider/model` is split at the first slash into the two fields (a model that holds slashes of its own keeps them); fields left empty are left out; seconds become `timeoutMs` (`1.5` is `1500`, from 0.001 to 10); the thresholds the form has no field for stay as they are. Nothing is saved until **Save**. A default with no provider, or no default at all, is refused in the loader's words, and so is removing the default while `model` is `auto`. |
| `auto-mode` | `permissions.autoMode` (Models, *Auto mode reviewer*): a *Reviewer model* box and four lists, *Always allowed* (`allow`), *Blocked unless you said so* (`softDeny`), *Always blocked* (`hardDeny`) and *Trusted here* (`environment`) | Only the keys that are set, in the order `model`, `allow`, `softDeny`, `hardDeny`, `environment`, under `permissions.autoMode`; nothing else in `permissions` is touched, and an empty table removes `autoMode`. A list left out keeps the built-in rules and the row shows them as one entry, *Built-in rules* (`$defaults`); adding to it writes `[$defaults, <entry>]`, so the built-ins stay; removing that entry writes a list without it (`[]` removes the built-ins); **Use built-in rules** takes the key out. The model is written as `provider/model`, a bare model of the session's provider, or `smallModel` for the side model (offered in the box). Asks first (`confirmWhen: 'loosens'`) when the model changes, when an entry is added to *Always allowed* or *Trusted here*, or when an entry (including the built-ins) is removed from *Blocked unless you said so* or *Always blocked*; the question names the model and each entry. The entries are sentences, so they read in the row's own type (`settings-config-name`), not in the monospace style of tools, paths and patterns. A change that only restricts saves at once. |
| `permission-rules` | `permissions` (Projects, *Permission rules*): one line for each rule, a tool (or a `sources` entry) with an optional pattern of its input, and an answer, Allow, Ask or Deny, with Remove; a line below adds one | Only the rules inside `permissions`: `tool: effect` for a whole tool, `tool: { pattern: effect }` for patterns (a whole-tool rule beside pattern rules is written as the pattern `*`). The mode keys that share the table, `defaultMode`, `disableBypassMode`, `disableAutoMode`, `outsideRoot` and `autoMode`, are never read into the rule lines and never changed: they stay as written after every edit, and **Use default** removes only the rules (the key goes when nothing else is left in it). The `allow`, `ask` and `deny` lists of `Tool(specifier)` strings are read as the loader folds them and saved back as the per-tool table. An entry is refused with the engine's own sentence (an unusable pattern, a bad answer); a table that names a mode key is refused, and so is a tool spelled in upper case (`Bash`), which the engine would never match: write `bash`. A whole-tool rule and the pattern `*` are the same rule, and rules written as the `allow`, `ask` and `deny` lists are compared as the rules they fold into before anything asks. Asks first (`confirmWhen: 'loosens'`) only when a change lets more run without a person (a rule that allows added, a rule changed to a more permissive answer, a deny or ask rule removed, including by **Use default**) and names the rule; a change that only restricts saves at once. |
| `permission-checks` | `permissionChecks` (Projects, *Permission self-checks*): a line for each check, tool, input and the answer it must get, with Remove; a line below adds one, with a command box for a shell tool (`bash`) and a small JSON object box for any other | A list of `{ tool, input, expect }`, `input` an object as the engine reads it (a shell tool's is `{ command }`), `expect` `allow`, `ask` or `deny`. A bad entry is refused with the loader's words and its place (`permissionChecks[1]: expected an "input" object for bash; got string`). The list is empty means the key goes. The example in the descriptor is a valid check. Asks first when a check is removed or changed, naming it; adding one never asks. |
| `sites` | `browser.sites` (Tools, *Browser sites*): a line for each site as the engine matches it (`https://example.com`, `https://*.example.com`, `http://localhost:*`) with Deny, Read, Ask or Act and Remove, and a fixed line *Every other site* (`*`) that shows the engine's default, Ask | The map, with each site as the loader writes it and `*` last, and `*` left out while it is on its default. A site with no scheme, a path or a level other than the four is refused in the loader's words, and a site on two lines is refused. Asks first when a site becomes Act, or a site stops being denied (its Deny line removed or changed, counting a site with no line as *Every other site*), naming it; Deny, Read and Ask on their own never ask. |

`mcpServers` (Tools, *Tool servers*) is not a control of its own: the page draws a row for it, see
[Tool servers in Settings](desktop.md#tool-servers-in-settings). A `list` without a `picker` or `source` is words
typed one per entry, each with Remove, saved as a list of strings.

The default of a row is its typed `default`: a map for `levels`, the list of ticked values for a list. A
value that means the same as no key (every trigger at its default, every event ticked, the default
screen alone) is written as no key, so the file keeps following the default. Every write still goes
through the loader's own reader for the whole block, so a list Desktop sends is refused in the loader's
words if the loader would refuse it. `confirmWhen: 'drops-default'` asks only when a list leaves out
something the default holds; `confirmWhen: 'widens'` asks only when a list holds an entry the list in
force lacks (adding a folder asks, removing one does not); on a `toggle-list`, `confirmWhen: 'off'` asks
when the switch goes to its `off` list; `confirmWhen: 'loosens'` is the rule of the auto mode reviewer, the permission rules, the self-checks and the browser sites above, each by its own meaning of "lets more run without a person".

Model fields offer the models Desktop already lists for its composer and Pal pages (the providers that can answer, `namzu/providers/status`, and each one's list, `namzu/providers/models`), read the first time a model field is used and again after a key is saved or removed; a name that is not in the list is kept as typed. The terminal takes the same value as text (`smallModel`) or JSON (`routing`, `permissions.autoMode`, `permissions`, `permissionChecks`, `browser.sites`); `namzu config get` prints what each takes.

## Sections

General, Models and Projects keep their own rows and add the engine's below them under
**Namzu settings**. **Agent** (limits, workflows, compaction, memory, learning, skills, schedule,
hypermode), **Tools** (web, browser and its switch, code analysis, servers, hooks, plugins),
and **Telemetry** are made of the engine's rows. **Terminal** and **Updates** draw the app's own rows first and the engine's after, under headings the engine names. **Desktop app** holds only the app's own.

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
secrets. Their control is file only: `namzu config` and the generic Desktop row say **Set in your config file**
or **Not set** and never read the value out or write it. The one exception is the Tool servers row, which adds,
changes and removes a server's command or address through its own methods and never reads or shows a server's
variables or headers. Provider keys keep their own masked flow under Models.

## Not exposed

`permissionLayers` and `permissionSettings` are derived by the loader. `tui.spacesPrefix` is a deprecated
alias of `tui.workspacesPrefix`. Project-scope limits (for example a project cannot set `model` or
`decision`) stay in the loader; Desktop only edits the user file.
