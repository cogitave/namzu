---
type: Reference
title: Installed plugins
description: The install records, the settings that turn an installed plugin on or off, how installed plugins load and are checked, and namzu plugin list, details, enable and disable.
resource: packages/cli/src/integrations/plugins/records.ts
tags: [cli, plugins, records, settings, trust]
---

# Installed plugins

A plugin installed on this computer is a copy of its files under
`$NAMZU_HOME/plugins/cache/<marketplace>/<plugin>/<version>/`. What was accepted
when it was installed is written in three places, and a recorded yes or no in a
settings file says whether it runs. This page describes those files, the rules
that read them, how the session loads installed plugins and the commands that
show and change them. The commands that create and remove the records (install,
update, uninstall, prune and the marketplace commands) are on
[Install plugins](plugin-install.md); a record written by hand or by a script is
read the same way.

An id is `<plugin>@<marketplace>`: each half starts with a letter or digit and
holds letters, digits, `.`, `_` and `-`, at most 64 characters each.

## The files

```
$NAMZU_HOME/
  settings.json                          user records: enabledPlugins, extraKnownMarketplaces
  plugins/
    known_marketplaces.json              marketplaces added on this computer
    installed_plugins.json               one list of records per plugin id (version 2)
    .install-manifests/<id>.json         what was accepted: hashes, surface, consent
    cache/<marketplace>/<plugin>/<version>/   the copy that runs
    data/<id>/                           NAMZU_PLUGIN_DATA of an installed plugin
<project>/.namzu/
  settings.json                          the folder's shared records
  settings.local.json                    this computer's records for the folder
```

Every file is read and written through the same rules as the other small state
files: one change at a time under a lock, a recovery copy of the file as it was
first, and no overwrite of a file that exists but does not read. A file that
cannot be read stops what needs it with a sentence naming the file and the
reason, and nothing is changed or removed. The `plugin` commands never write a
`.corrupted` copy of such a file and have no way to start a new list: fix the file
or move it away, then run the command again. A key Namzu does not know is kept as it was
written when a record changes. An entry that is not a record is reported and left
in the file; it never stops the others.

### `installed_plugins.json`

```json
{
  "version": 2,
  "plugins": {
    "ledger@team-tools": [
      { "scope": "user", "installPath": "/home/me/.namzu/plugins/cache/team-tools/ledger/1.2.0",
        "version": "1.2.0", "layout": "namzu", "surfaceSha256": "e3b0..." },
      { "scope": "project", "projectPath": "/home/me/src/app",
        "installPath": "/home/me/.namzu/plugins/cache/team-tools/ledger/1.2.0" }
    ]
  }
}
```

An id holds at most one record per scope and folder. `scope` is `user`, `project`
or `local`; the last two need `projectPath`, the folder the record is for. A file
without `version: 2`, or with a newer one, does not read. `layout` is `common`
for a plugin read in the [common plugin layout](../sdk/common-plugin-layout.md)
and `namzu` for one with a `plugin.json`.

### `known_marketplaces.json`

A mapping from a marketplace name to `source` (`github`, `git`, `url`,
`directory` or `file`), `installLocation` and optional `lastUpdated`,
`autoUpdate` and `commit`.

### `.install-manifests/<id>.json`

Lists every file that can run or configure running (`executable`), the sha256 of
each (`files`), the `surface` that was shown (hooks, local servers, remote
origins, modules, pre-approved tools), one `surfaceSha256` over all of it and the
consent that was given. At every load the executable files are hashed again. A
plugin whose copy is not inside the plugin cache, has no readable manifest, whose
digest does not match, or whose executable file is missing, a link or different,
does not load:

```
ledger changed on disk after you accepted it, so it did not load. Reinstall it to review it again.
```

Only that plugin is stopped. The plugin folder is also walked: every file that
can configure what runs must be listed in `executable`, so a file added after
install, or left out of the list, stops the plugin too. Those are every `.json`
file, every `SKILL.md` (its front matter can attach hooks and pre-approve
tools) and every `.md` file in an `agents`, `commands` or `skills` folder. Other
files (a README, an image) are not checked.

## Turning an installed plugin on

```json
{
  "enabledPlugins": { "ledger@team-tools": true, "scratch@team-tools": false },
  "extraKnownMarketplaces": { "team-tools": { "source": { "source": "github", "repo": "acme/team-tools" } } }
}
```

These two keys, and only these, are read from the three settings files by a
reader of their own, so configuration precedence is untouched. Each file holds at
most 500 keys of each kind (a file with more does not read, and a write that
would add the 501st is refused), an id must match the pattern above, and a
profile may not declare either key. Every other key of the file is kept as
written.

- **Precedence.** The highest layer that speaks wins: this computer's file for
  the folder (`settings.local.json`), then the folder's shared file
  (`settings.json`), then yours (`$NAMZU_HOME/settings.json`). A project `false`
  turns a plugin you installed off in that folder.
- **A repository cannot turn a plugin on by naming it.** A project file's `true`
  counts only when this computer has an install record for that folder or you
  have the plugin at user scope. Otherwise it does not speak, and the trust screen
  and `namzu plugin list` show it as asked for here and not installed on this
  computer. Nothing is fetched or run because of it.
- **No answer means off.** An installed plugin needs a recorded yes. A settings
  file that does not read says nothing, and the session reports it.
- **Marketplaces in a project file are suggestions.** They are shown, never added.

## How the session loads them

When `plugins.enabled` is true the runtime loads installed plugins after the
hand-placed scan and before `--plugin-dir` folders:

1. The install record is read. A record that does not read stops every installed
   plugin for that session (hand-placed ones still load), with the file named
   and left as it is.
2. A record applies when it is yours (`user`), or a `project` or `local` record
   whose `projectPath` is the current folder, the folder is trusted, and its
   scope is in `plugins.allowedScopes` (a `local` record counts as `project`
   there). An untrusted folder reads no project record and neither of its two
   settings files. `plugins.autoDiscovery: false` does not hide installed plugins:
   they are explicit records.
3. If an id has records at several scopes the most specific one applies (local,
   project, user).
4. The copy is checked against its install manifest, then admitted from its cache
   folder, which is its authority root. A plugin in the common layout is read
   with its install sidecar, which is read nowhere else.
5. A plugin that fails any step is skipped and reported at launch and by
   `namzu plugin list`; the others load. A name already used by a hand-placed
   plugin (also a disabled one) or a `--plugin-dir` folder keeps the plugin that
   holds it; between two installed plugins with one name the one installed first is
   loaded. `list`, `details` and `enable` report the clash with hand-placed
   plugins and with installed ones as `blocked`; a `--plugin-dir` folder of one
   launch is not known to them.

`NAMZU_PLUGIN_ROOT` is the cache folder and `NAMZU_PLUGIN_DATA` is
`$NAMZU_HOME/plugins/data/<id>/`. In a session, **Keep enabled/disabled after
restart** writes the answer for you in `$NAMZU_HOME/settings.json` for a user
install, and in `.namzu/settings.local.json` for a project or local install, so a
shared file is never edited by a toggle. If this computer's file for the folder
or the shared file still says the opposite for a user install, the answer is
written to this computer's file as well, so it holds on the next start. Command and agent files of a plugin that
is on reach the session like those of any other plugin.

## Trust screen

When a folder's settings files name plugins or marketplaces, the trust screen
lists them before you answer: each plugin as installed on this computer, asked for
here and not installed on this computer, or turned off here; each marketplace as a
suggestion that is not added; and the hook commands an installed plugin the folder
turns on would run.

## Commands

```bash
namzu plugin list [--cwd <dir>] [--json]
namzu plugin details <id> [--cwd <dir>] [--json]
namzu plugin enable <id> [--scope user|project|local] [--cwd <dir>] [--json]
namzu plugin disable <id> [--scope user|project|local] [--cwd <dir>] [--json]
```

An id may be a bare plugin name when only one installed plugin has it; with
several the command exits 64 and names them. `--cwd` is the folder whose project
plugins are meant (default: here). Nothing here runs a plugin or fetches anything.

- **`list`** shows the plugins that apply here: id, version, scope, `on`, `off` or
  `blocked` (changed on disk, unreadable, or its name is already used by another plugin), and how many things need a look. It
  also lists plugins this folder asks for that are not installed, marketplaces
  it declares, and files that did not read. `--json` prints
  `{ command, cwd, trusted, loading, plugins[], asked[], declaredMarketplaces[], problems[], notice? }`;
  each plugin has `id`, `name`, `marketplace`, `version`, `scope`, `projectPath?`,
  `enabled`, `enabledBy` (`user`, `project`, `local` or `null`), `state`,
  `attention`, `problem?`, `source` (the marketplace's source when this computer knows it, else `null`), `layout` and `installPath`.
- **`details`** shows one plugin: its description, the skills, commands, agents,
  hooks (event and number of entries) and servers it brings by their exact names (`<plugin>__<name>`), its record, who
  turned it on, its origin marketplace (`origin` in `--json` is the marketplace's source, else what the install manifest says it came from), the executable files and surface digest, the
  consent record and its data folder with size. `--json` adds `verification`,
  `records[]`, `surface`, `consent`, `data` and `inventory`.
- **`enable`** and **`disable`** record a yes or a no. Without `--scope` the answer
  goes to your own file for a user plugin and to this computer's file for the
  folder (`settings.local.json`, "off for me") for a project or local plugin;
  `--scope project` edits the shared `.namzu/settings.json` and `--scope local`
  or `user` the matching file. They say so when the answer is already recorded,
  when a higher layer still decides, when the plugin is blocked and will not load, and when `plugins.enabled` is off so the
  plugin will not run. It takes effect in new conversations. `--json` prints
  `{ command, outcome (enabled, disabled, unchanged or failed), id, scope, message, effective, loading, notes? }`.

A failure prints `{ command, outcome: "failed", message, id? }` under `--json`.

Exit status: 0 done (also "already so" and a listing with problems in it), 1
something failed, 64 the command line is wrong, 66 the plugin is not installed or
a record could not be read (the file is left as it is), 77 `--scope project` or
`local`, or a project plugin, in a folder that is not trusted yet.
