---
type: Reference
title: Plugins in the CLI
description: Load trusted Namzu plugins and inspect or change them, with their errors and skill use, on the /plugin screen.
resource: packages/cli/src/integrations/plugins/runtime.ts
tags: [cli, plugins, tools, skills, hooks]
---

# Plugins in the CLI

Namzu's SDK plugin runtime is connected to the CLI. A plugin can contribute
tools, skills, JavaScript hooks, stdio MCP servers, slash commands and agents. The CLI runs its plugin
runtime in the main agent session; delegated agents receive separate toolset
rosters and do not inherit executable plugins.

## Enable loading

Plugin loading is off by default. Set this in the user configuration
`$NAMZU_HOME/config.yaml` (`~/.namzu/config.yaml` by default), or in the trusted
project's `.namzu/config.yaml`:

```yaml
plugins:
  enabled: true
  allowedScopes: [project, user]
  autoDiscovery: true
  hookTimeoutMs: 30000
```

Only the boolean `true` enables loading. These are file settings; environment
variables do not enable executable plugins. `allowedScopes` defaults to both
scopes, `autoDiscovery` defaults to true after enablement, and `hookTimeoutMs`
defaults to the SDK hook timeout. An empty scope list admits neither location.

Project plugins live in `<working-directory>/.namzu/plugins/<directory>/`.
User plugins live in `$NAMZU_HOME/plugins/<directory>/`. Each directory contains
a Namzu `plugin.json`, for example:

```json
{
  "name": "ledger",
  "version": "1.0.0",
  "description": "Ledger review instructions",
  "instructions": "Explain the evidence before using ledger tools.",
  "skills": ["skills/reconcile"]
}
```

If both locations resolve to the same physical plugin directory, it is treated
as user scope and scanned once. A project-only configuration does not admit that
shared user directory. Sharing an application root alone does not merge two
different plugin directories.

That skill directory contains `SKILL.md` with a `name` and `description` in YAML
frontmatter. Its registered name is `ledger__reconcile`. If the skill declares
`allowed-tools`, loading it pre-approves those tools for the rest of that turn.
It never removes a tool, and deny rules and plan mode still win; see
[Skills and allowed-tools](../sdk/skills.md). Enabling a plugin that carries such
a skill trusts that skill's listed commands. The optional `instructions` text
is plugin-authored context. It is labelled as untrusted material in each model
request while this plugin is enabled, and disappears when the plugin is
disabled. Tools and hooks declare
JavaScript module paths (a path in `hooks` that ends in `.json` is a file of hook
entries instead, see [Hook entries](#hook-entries)); MCP servers declare their stdio command, optional
arguments and environment. A plugin MCP server may set `connectTimeoutMs`
(a positive integer up to one hour; default 10,000 ms) for its entire startup
handshake and discovery. Unknown fields inside a plugin MCP server declaration
are refused at manifest load time. In particular, plugin manifests do not
accept `url`, `headers`, `inheritEnv` or `requireApproval`: configure a remote
server in `mcpServers`, and use a source permission rule for a plugin-owned
server. A remote server in a Namzu `plugin.json` goes under `remoteMcpServers`
(an `url`, an optional `transport` and `headers`): it is read and listed and not
started yet. `connectors` and `personas` in a Namzu `plugin.json` are not
supported and are refused rather than ignored.

### Plugins in the common plugin layout

A plugin folder written in the layout other tools share loads without a
`plugin.json`: put it under `.namzu/plugins/` or `~/.namzu/plugins/`, or name it
with `namzu --plugin-dir <folder>`. Namzu reads its manifest, or just its
conventional folders (`skills/`, `commands/`, `agents/`, `hooks/` and a root
servers file), and every skill, command and agent in them is found without being
listed. A scan of `.namzu/plugins` finds a folder that has a manifest; a folder
with only conventional folders is loaded when you name it with `--plugin-dir`.

Namzu's own names stay: skills are `<plugin>__<skill>`, commands are
`/<plugin>__<command>` (for these plugins `/<plugin>:<command>` is accepted too,
so the plugin's own documentation works), and a command or agent file may be a
single file as well as a folder. `${NAMZU_PLUGIN_ROOT}` in a skill, command or
agent text is replaced by the plugin's folder. A hook of such a plugin also finds
its folders under the three names it was written for. Remote servers are read and
listed and are not started yet, and a plugin in this layout may hold up to 64 skills
and 16 servers. A hand-placed folder Namzu refuses is reported and the other
plugins still load. What Namzu has no place for (themes, settings, saved options) is said
once at launch; `namzu plugin validate` shows the whole report. The full rules
are in [the common plugin layout](../sdk/common-plugin-layout.md). You can place
the folder yourself, or install it from a folder, an archive or a local
marketplace with `namzu plugin install`; see [Install plugins](plugin-install.md).

### Hooks modules (common layout)

A plugin in the common layout may name one hooks module in `hooks/hooks.json`
(`"modules": ["./mod.js"]`, the path relative to the hooks file). Namzu runs it
in an isolated worker while the plugin is on and stops it the moment the plugin
is turned off or the session ends; the SDK page [hooks modules](../sdk/common-plugin-layout.md#hooks-modules)
has the API, the limits and what is refused. What you see before it runs:

- **The trust screen** for a project folder lists it among the hooks the folder
  runs without asking, as `hooks module (plugin <name>): hooks/mod.js runs in an
  isolated worker: hooks PreToolUse, Stop; runs commands; uses the network`, or
  says the module is not run and why.
- **`namzu plugin validate`** prints the same lines, each pattern and each call
  ([a hooks module](plugin-validate.md#a-hooks-module)).
- **`plugins.enabled`** and your saved yes for the plugin still decide whether
  the plugin is on at all; a module never starts before both. A hooks switch
  that leaves plugin hook entries listed and not attached (`disableHooks`,
  `hooksManagedOnly`) leaves the module unstarted too.

A module that cannot load (refused by the scan, throws as it registers,
registers nothing that runs here) is said once at launch as `Plugin <name>:
hooks module <file> not loaded: <reason>`, and the plugin's other parts keep
loading. A hook of a module that fails refuses the tool call it guards (on
`pre_tool_use`), with the reason, instead of letting the call through. A plugin
that ships only `.js` hooks under its own `plugin.json` is unchanged: those
modules run in the process, not in a worker.

### Hook entries

A plugin can ship shell, http and prompt hook entries beside its JavaScript hook
modules. Namzu reads `hooks/hooks.json` in the plugin folder when it exists (the
conventional place, so a plugin written for the common hook contract moves as
written), each `.json` path in the manifest's `hooks`, and the manifest key
`hookEntries` (the same events object written inline), in either shape. The
two spellings the common hook contract uses for the manifest key are read too:
`"hooks": "./hooks/hooks.json"` is a list of one path, and `"hooks": { <events> }`
is `hookEntries`. A path that leaves the plugin folder is refused and named.

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "${NAMZU_PLUGIN_ROOT}/scripts/guard.sh" }] }
    ]
  }
}
```

A command is started with `NAMZU_PLUGIN_ROOT`, the plugin's folder, and
`NAMZU_PLUGIN_DATA`, a folder kept for the plugin under the Namzu home and never
inside the plugin; a shell command expands them from its environment (and so
does a script it starts, for the names the command used), and an entry in the
exec form has them put in its command and arguments. The
entries run while the plugin is enabled and stop the moment it is disabled.
`/hooks` lists them apart from the plugin's JavaScript hooks, `/plugins` shows
how many a plugin ships, and `disableHooks`, `NAMZU_DISABLE_HOOKS` and
`hooksManagedOnly` turn them off (the plugin's JavaScript hooks are not touched).
A project plugin is read only after the folder is trusted, and the trust prompt
lists the entries it would run. [Hook events](../sdk/hooks.md#hook-entries-a-plugin-ships)
describes the rules in full, and [`namzu plugin validate`](plugin-validate.md)
checks them.

### Commands and agents

A manifest can list folders of markdown files, relative to the plugin folder:

```json
{
  "name": "ledger",
  "version": "1.0.0",
  "description": "Ledger review",
  "commands": ["commands"],
  "agents": ["agents"]
}
```

Each `.md` file in a `commands` folder is a slash command written like the
files in `.namzu/commands/` (a prompt template with an optional `description`
and `argument-hint`, and `$ARGUMENTS`). It is named after its plugin, so
`commands/audit.md` in `ledger` is `/ledger__audit`. Each `.md` file in an
`agents` folder is an agent file written like the ones in `.namzu/agents/`, and
the model sees it as `ledger__<name>`. A command or agent file of the user or
project with the same full name wins over the plugin's. A folder that does not
exist, or that leads outside the plugin folder through a link, is skipped and
named in the log. Paths with `..` or a drive or root are refused when the
manifest is read.

Commands and agents come from plugins that start enabled and stay as they
were at startup: disabling a plugin from `/plugins` removes its tools, skills
and hooks at once, and its commands and agents after the next start. These
files run no code of their own, but an agent runs with the tools its file names.

### Declare where a plugin runs

A manifest may say which operating systems and which Namzu versions it supports:

```json
{
  "name": "ledger",
  "version": "1.0.0",
  "description": "Ledger review",
  "platforms": ["linux", "darwin"],
  "engines": { "namzu": ">=60.0.0 <62" }
}
```

`platforms` uses the names Node reports (`linux`, `darwin`, `win32`). `engines.namzu`
takes space-separated comparators that must all hold (`>=`, `>`, `<=`, `<`, `=`,
`^`, `~`), with `||` between alternatives; a bare `60` names the whole major.
A plugin that declares neither loads everywhere, as before. One that does not fit
is refused when it is read, with a reason such as "Plugin "ledger" needs Namzu
>=61.0.0, and this is Namzu 60.2.1, so it was not loaded." A range that cannot be
read is refused too, not guessed at. The version compared is the Namzu SDK
runtime the session runs on; a build that cannot read its own version skips the
range check rather than refusing every plugin.

### Try a plugin for one launch

`namzu --plugin-dir <folder>` loads the plugin in that folder for this launch
only, even when `plugins.enabled` is not set and from outside the project. The
flag may be repeated, and also applies before `namzu exec`. Naming the folder is
the consent: the plugin's tool modules, hooks and MCP servers run, so name only
folders you trust. Nothing is written to the configuration, and the saved
start-up state in `/plugins` still applies.

A JavaScript tool module must export complete tool definitions, including an
`inputSchema` that the SDK can parse and render. A missing or unusable schema
refuses plugin enablement with the plugin and module named, before the tool
appears in a session.

Review executable plugins before enabling loading: module imports and hooks
execute in the CLI process, and MCP servers start child processes. Tool approval
is not a sandbox for plugin startup code. Project trust and admitted scope roots
still apply. Refused manifests stop plugin startup and roll back already loaded
contributions. A failed or timed-out MCP handshake starts bounded transport
shutdown before rollback completes. The shipped stdio transport escalates to
process termination if its child does not exit. This menu does not install
plugins. `namzu plugin install` does, from a folder, an archive or a marketplace
that is a folder or a file on this computer (nothing is downloaded yet); see
[Install plugins](plugin-install.md). Plugins that were installed on this
computer (they have an install record) load as a third source and are managed
with `namzu plugin list`, `details`, `enable`, `disable`, `update` and
`uninstall`; see [Installed plugins](plugin-records.md).

## Installed plugins

A plugin installed on this computer is a copy under `$NAMZU_HOME/plugins/cache/`
with an install record, an install manifest and a recorded yes or no in a
settings file. When `plugins.enabled` is true the runtime loads these after the
hand-placed plugins above and before folders named with `--plugin-dir`. They
are explicit records, so `plugins.autoDiscovery: false` does not hide them;
`plugins.allowedScopes` and folder trust still decide which records apply. A
plugin whose executable files changed since you accepted it, or that cannot be
read, is skipped and reported; the others load. The folders `cache`, `marketplaces`
and `data` under `plugins/` are Namzu's own state and are never scanned for
hand-placed plugins. Everything about the records, the settings keys, who may
turn a plugin on and the four commands is on [Installed plugins](plugin-records.md).

## Check a plugin before you share it

`namzu plugin validate [path] [--json]` checks a plugin folder and every part it
carries (manifest, skills, tool and hook modules, MCP server entries, commands
and agents) with the loader's own rules, and prints each problem with its file,
line, a sentence about what is wrong and what the loader would do. It runs
nothing from the plugin and reads only inside the folder. Exit status is `0`
for no problems, `10` for warnings only, `1` for errors and `66` when the
folder cannot be read. See [namzu plugin validate](plugin-validate.md).

When a plugin is refused at startup, or a command or agent folder or file of
one is skipped, the message ends with a line pointing at that command.

## The plugin screen

`/plugin` (and `/plugins`, the same command) opens one screen with a tab row,
`Plugins  Installed  Errors  Stats`. ←/→ switch tabs and Esc closes; inside a
detail view Esc goes back one step first.

```
 Plugins  Installed  Errors  Stats

 ╭────────────────────────────────────╮
 │ ⌕ Search installed items…          │
 ╰────────────────────────────────────╯
   MCP servers
 ❯ ✓ tickets       MCP     connected · 12 tools

   Plugins
   ✓ ledger        Plugin  project · 2 skills

   Skills
   ✓ release-notes Skill   project · ~20 tok · 3× 2d
   ✓ review-diff   Skill   project · < 20 tok · never used
 ↑/↓ to navigate · ←/→ to switch · Space to toggle · / to search · Enter to select · Esc to close
```

**Installed** lists what this conversation has, in three sections: tool
servers (connected, connecting or failed), plugins, and skills. A section whose
search matches nothing is left out; with no plugin loaded the Plugins heading
stays and says why (loading off, discovery off, or none found). `/` searches
name, kind and place.

- **Space** turns the selected plugin on or off for this conversation, the same
  per-conversation change as before. On a skill or a tool server it explains
  where to change it instead (`/skills`, `/mcp` and your configuration).
- **Enter** opens a detail view. A tool server shows its status, its command or
  address (without credentials or query string) and its tool count, with
  **View tools** to list them. A plugin shows its directory and contributions
  (what `/plugins <name>` prints) with **Disable/Enable for this conversation**
  and **Keep enabled/disabled after restart**. A skill shows its file, place,
  state, listing cost and use. Esc or **Back** returns to the list.

A skill's row reads `<place> · ~N tok · <uses>×  <age>` or `never used`.

**Errors** lists what failed to load, each with what to do: a plugin whose
startup setting or manifest is bad, a tool server that did not connect, a skill
whose `SKILL.md` does not parse. When there is nothing it says `No plugin errors`.

**Stats** is the *Skills loaded this session* table: Skill, Source, Context (the
skill's one-line listing cost, a dash when it is not in the listing), 7d tokens,
Uses and Last used, least used first. At narrow widths Source goes first, then
7d tokens. Uses, Last used and 7d tokens come from a small record Namzu keeps in
`$NAMZU_HOME/skill-usage.json`: each load of a skill (the model's `skill` tool
or a typed `/<name>`) adds one use and the size of what it loaded, loads of one
skill within a minute count once, and a load's size is kept for seven days. The
file counts from the day it was first written, which the screen states; skills
used earlier show `0` and `never`. 7d tokens is the estimated size added to the
conversation (4 characters per token), not a billed figure. A conversation that
is not kept writes nothing. The record is best effort: it is replaced whole
without a lock, so two conversations loading skills at the same moment can lose
one of the two uses.

There is no Discover or Marketplaces tab and no favorites: this screen lists
what the conversation has, and installing and marketplaces are the
`namzu plugin` commands ([Install plugins](plugin-install.md)); nothing yet
gives a favorite a meaning. Tool servers are not
grouped by scope because a connected server does not carry where it was
configured.

Also, `/plugins list` prints the current roster and `/plugins <name>` prints one
plugin's full directory, version, scope and contributions. `/help plugin`
explains the command without running it.

Opening the screen does not discover plugin directories, import code or call a
model. It reads the current session's runtime and saved startup settings. When
loading or discovery is off, or there are no loaded plugins, the Plugins section
says why; `/plugins list` with no plugin prints the full report with the
configuration and admitted plugin directory paths.

Tool and skill lists are registered runtime contributions. Hook modules and
MCP server names are explicitly labelled as manifest declarations; a declaration
does not establish a live MCP connection. MCP environment values and hook bodies
are not included in the operator snapshot.

Choose **Disable for this conversation** to remove a plugin's tools, skills and hooks
and disconnect its MCP servers. **Enable for this conversation** registers them again
using the existing SDK lifecycle. A failed change is reported and the screen reads
the runtime's resulting state. Changes require an idle session: the host refuses
them during sends, compaction or durable resume, and refuses new invocations
while a change is settling. Closing the session waits before releasing resources.

Session enable/disable changes do not edit configuration or delete plugin files.
They reset when Namzu restarts or a model/provider switch reconstructs the
session. The detail view shows both the live state and the startup setting.
Already recorded conversation history is retained.

## Remember a plugin's state

After changing the session state, select **Keep disabled after restart** or
**Keep enabled after restart** to save it. Saving is a separate, explicit action;
it does not call a model or repeat plugin activation. A failed save leaves the
live state unchanged and reports the error. Other already-running sessions keep
their current state; the setting applies when their plugin runtime next starts.
Opening a plugin's detail view reads the saved setting again, so another session's save
is visible without changing the current live contributions. A setting damaged
after startup is shown as blocking the next startup, with its error in Details.

Settings live under `$NAMZU_HOME/plugin-settings/`, in private JSON records
keyed by a SHA-256 digest of the canonical plugin directory and manifest name.
Records contain `version: 1`, `rootDir`, `name` and `enabled`. This keeps two
projects' same-named plugins independent, while a user plugin's setting follows
that plugin across projects. Replacing its version in the same directory keeps
the setting; moving it or changing its name gives it a separate identity.

Each record is replaced atomically. Concurrent saves for separate plugins do
not overwrite one another; for the same plugin the last complete save wins.
An absent setting uses normal enabled-at-startup behavior. An unreadable or
invalid setting stops plugin startup rather than silently re-enabling code.
The error includes the exact record path for repair or removal.

A remembered disabled plugin still has its manifest validated and appears on
the screen, but its tool and hook modules are not imported, skills are not loaded,
and MCP processes are not started. Invalid manifests still stop startup.
Remembering an enabled state does not override project trust, `plugins.enabled`,
discovery or allowed scopes. To change installed plugin files or loading
configuration, make the change and restart Namzu.
