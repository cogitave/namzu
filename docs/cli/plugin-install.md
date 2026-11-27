---
type: Reference
title: Install plugins
description: namzu plugin install, update, uninstall and prune, and namzu plugin marketplace add, list, update and remove, for folders, archives, local marketplaces and downloaded ones; the preview of everything a plugin runs, the digest you accept, scopes, exit codes and crash safety.
resource: packages/cli/src/commands/plugin-install.ts
tags: [cli, plugins, install, marketplace, consent, trust]
---

# Install plugins

`namzu plugin install` puts a plugin on this computer after you have seen
everything in it that can run. It works from a plugin folder, a plugin archive
(`.zip` or `.plugin`) and a plugin listed in a marketplace, which is a folder or
a `.json` file on this computer or one that was downloaded from a Git repository
or an https address. Downloads, their limits and what is refused are on
[Marketplaces and downloads](plugin-marketplaces.md); this page is about what
happens with a plugin once it is in hand.

What an installed plugin is, where its records live and how it loads is on
[Installed plugins](plugin-records.md). Plugins written in the layout other
tools share are read as [the common plugin layout](../sdk/common-plugin-layout.md)
says.

```
namzu plugin marketplace add <folder|file.json|owner/repo|https://…> [--ref <ref>] [--sparse <path>...]
                             [--scope user|project|local] [--dry-run] [--yes] [--json]
namzu plugin marketplace list [--json]
namzu plugin marketplace update [<name>] [--json]
namzu plugin marketplace remove <name> [--yes] [--json]
namzu plugin install <name>@<marketplace> | <folder> | <file.zip|file.plugin>
                     [--scope user|project|local] [--dry-run] [--enable-loading]
                     [--yes | --accept-surface <sha256>] [--cwd <dir>] [--json]
namzu plugin update <id> [--dry-run] [--yes | --accept-surface <sha256>] [--cwd <dir>] [--json]
namzu plugin uninstall <id> [--scope user|project|local] [--delete-data] [--yes] [--cwd <dir>] [--json]
namzu plugin prune [--dry-run] [--yes] [--json]
```

## Marketplaces

A marketplace that is downloaded (`owner/repo`, an https address) is covered by
[Marketplaces and downloads](plugin-marketplaces.md); what follows is the same
for every kind. A marketplace on this computer is a folder holding the catalog file of
[the common plugin layout](../sdk/common-plugin-layout.md) (or a
`marketplace.json` at its root), or that `.json` file itself. `marketplace add`
registers it where it is: nothing is copied, and its catalog is read again each
time it is needed. The catalog names the marketplace, an owner and a list of
plugins, each with a `name` and a `source`. A source that is a folder path
starting with `./` (or a bare name under the catalog's `metadata.pluginRoot`) is
installable: it is resolved inside the marketplace's folder, and a link that
leads out of it is refused. A source that is a repository (`github`, `url`,
`git-subdir`) or an https `archive` is downloaded when you install it; one that
would run a package manager or another program (`npm`, `command`, request
headers) is listed and marked not installable. A catalog is read from a
regular file of at most 10 MiB and lists at most 500 plugins; an entry with no
name or source is left out and reported.

Adding a marketplace writes `known_marketplaces.json` with a consent record
(`at`, `by`, `notice`) and an `extraKnownMarketplaces` entry in the settings file
of the scope (default `user`; `project` and `local` need a trusted folder). A
path you typed is its own consent, and the notice still prints: plugins from a
marketplace can run programs on this computer. The name must be 1 to 64 lowercase
letters, digits, `.`, `_` or `-`, starting with a letter or digit, with no `..`.
These names are refused (exit 65): `local-uploads`, `inline`, `builtin`,
`synced`, `namzu`, anything starting `namzu-`, and the names of another tool's
official catalogs or names built to look like them. The same name from the same
place is a no-op; the same name from another place is refused.

`marketplace list` shows each marketplace with its plugin count, how many of
them are installed and whether auto-update is on (it is off; auto-update is not
part of this change), and the marketplaces the folder's own settings declare and
this computer has not added. `marketplace remove` shows the plugins it will
uninstall and the settings entries that go, asks, and keeps every plugin's data;
the marketplace's own folder is never touched, and a copy Namzu downloaded is
removed with it.

## Install

`install` takes one argument. It is read as a path when it has a path
separator, starts with `.` or `~`, or ends `.zip` or `.plugin`; otherwise as
`<name>@<marketplace>`, or as a bare name that exactly one added marketplace
lists (several: exit 64 with the choices). A bare word that is also a folder is a
name, and the not-found sentence says to write `./name` for the folder. A
plugin installed from a file or a folder gets the marketplace id `local-uploads`
(`name@local-uploads`).

1. The plugin is copied into `$NAMZU_HOME/plugins/.staging/<id>/`. A link inside
   a folder is not copied and is reported; `.git`, `__MACOSX` and `.DS_Store`
   are left out; at most 20 000 files and 256 MiB are copied. An archive goes
   through the shared zip checks first (5 000 entries, 256 MiB unpacked, a
   ratio of 100, no path that climbs out, no two names that differ only by case,
   no link or device, at most 200 MiB), and one wrapping folder is stepped into.
   A folder that holds the Namzu home is refused.
2. The copy is read in its own layout. A plugin-level refusal (a bad name, a
   version with characters a folder name cannot hold, an entry whose catalog name
   differs from the plugin's, nothing usable, a name another plugin already uses)
   exits 65 and removes the staging folder.
3. **The preview.** Everything that runs on this computer is listed, with the
   digest of it:

```
Install ledger 1.2.0 from team-tools?   scope: user (every folder on this computer)

  Skills (1):   ledger__reconcile
  Commands (1): /ledger__close
  Runs on this computer:
    hook      pre_tool_use Bash  ->  ${NAMZU_PLUGIN_ROOT}/scripts/guard.sh
    server    ledger-db  ->  node ${NAMZU_PLUGIN_ROOT}/server.js   (environment: MODE)
    server    ledger-api  ->  https://mcp.example.com   (asks you before it connects; would send $LEDGER_TOKEN)
    script    scripts/guard.sh  (17 B, executable)
  Pre-approves tools: skill reconcile allows Bash(git log:*), Read

This plugin runs programs on your computer with your permissions. Namzu cannot
check what they do. Install only plugins you trust.
Surface: sha256:46c6698a…
```

The listing has a line for every kind of runnable thing: **hooks** with their
event, matcher and what they run (a command, an address or a prompt); **hooks
that a skill, command or agent file carries** in its front matter; **local
servers** with command, arguments and the names of their environment variables;
**remote servers** with the origin they reach and the environment variables a
`${NAME}` in the address or a header would send (a server that needs a variable
that is not set here is still listed); **modules**, both the JavaScript a
manifest lists as hooks, which runs inside the session, and the hooks module a
common-layout plugin names in its hooks file, which runs in an isolated worker;
**scripts**, meaning every file
with an execute bit, a program extension (`.js .mjs .cjs .sh .ps1 .bat .cmd .py
.rb .pl`) or a place under `bin/` or `hooks/`; and the **tools a skill or command
pre-approves**. What Namzu has no place for, and what it left out of a hooks
file or a skill, is listed too, so nobody assumes it runs. A name or command
from the plugin is shown without its control characters. The first twelve
scripts are shown; `--json` has all of them.

For a module a manifest lists as hooks, the preview names the file and says
that what it declares is not read before it runs. For the hooks module of a
common-layout plugin, the source is scanned (never run) and the preview says
what it hooks and whether it runs commands, reads files or uses the network; a
module the scan refuses is listed as not run, with the reason. In `--json` a row
of `surface.modules` is `{ path, isolated?, declares?, refused? }`. See
[Hooks modules](../sdk/common-plugin-layout.md#hooks-modules) for what such a module may do.

A server that needs a variable which is not set here is still listed, marked
`needs setup`, with the variables it would send; it is not started or connected
until they are set. `Not used by Namzu` names only parts that are ignored, never
a server that is listed above.

The surface digest is the sha256 of the listing above together with the hash of
every regular file in the plugin (so a hook module, a file a server or hook
names, and a script with any extension are all inside it). `plugin details` says
how many files are checked before the plugin loads.

4. **The answer.**
   - `--yes` accepts what is shown; the preview is still printed on standard
     error (not with `--json`).
   - `--accept-surface <sha256>` accepts only the surface with that digest;
     another digest exits 75 with `What this plugin does changed since you read it.
     Read it again with --dry-run.` `--yes` and `--accept-surface` together exit 64.
   - In a terminal you are asked `Install? [y/N]`. No is exit 1 and nothing is changed.
   - With no terminal and neither flag the preview is printed and the command
     exits 75, having changed nothing.
   - `--dry-run` prints the preview (or, with `--json`, the whole surface) and
     exits 0, having installed nothing.
5. **The move.** Under the lock of `installed_plugins.json`, in this order: the
   staging folder is renamed to `cache/<marketplace>/<plugin>/<version>/`, the
   install manifest is written (hashes, surface, consent), the record is added,
   and `enabledPlugins[id]` is set to true in the settings file of the scope.
6. **Plugin loading.** If `plugins.enabled` is not true, a terminal is asked
   `Plugin loading is off on this computer. Turn it on? [y/N]`; a yes writes it as
   `namzu config set plugins.enabled true` does. `--enable-loading` does the same
   without asking. `--yes` never turns it on. Otherwise the command says how.

Scopes: `user` (default) writes `$NAMZU_HOME/settings.json`; `project` writes the
shared `.namzu/settings.json`; `local` writes `.namzu/settings.local.json`. Both
need a trusted folder (exit 77 otherwise). An id has one copy on disk that all
its scopes share, so a second scope of the same version, with the same
contents, adds a record and copies nothing. A different version is refused
(change it with `update`), and so is the same version with other contents
(`This version already exists with other contents; nothing was changed.`).
Installing what is already installed, with the same contents, exits 0 and says
so; if a crash left it installed without its recorded yes, the yes is recorded.

A plugin name may be used by one plugin only. Installing a plugin whose name an
installed plugin or a hand-placed plugin folder already uses exits 65 with
`The name "x" is already used by <other>. Remove it first, or ask the author to
rename this plugin.`

A catalog entry with `"strict": false` may name components inline (`skills`,
`commands`, `agents`, `hooks`, `mcpServers`); they are written beside the copy as
`.namzu-entry.json`, which is read only for a plugin with an install record, is
part of the listing and is hashed like any other configuration file. A file of
that name that came with the plugin is removed.

## JSON and exit codes

`--json` prints one object on standard output and nothing else there; the
preview, the notice and every question go to standard error. The object has
`command`, `outcome` (`installed`, `already-installed`, `declined`, `dry-run`,
`failed`, and for the other commands `updated`, `up-to-date`, `uninstalled`,
`disabled`, `pruned`, `nothing-to-do`, `added`, `already-added`, `removed`),
`message`, and for an install `id`, `scope`, `version`, `commit` (the commit of a
repository, or null), `layout`, `findings`, `surface`, `surfaceSha256`, `inventory` and
`loading`.

| Exit | Meaning |
|---|---|
| 0 | done, including "nothing to do" and an install with findings |
| 1 | failed, or you answered no |
| 64 | the command line is wrong, or an address that is never accepted |
| 65 | refused data: an unsafe archive, a plugin-level refusal, a name clash, a reserved marketplace name |
| 66 | not found, or an install record that cannot be read (nothing is changed and the file is kept) |
| 69 | unavailable: `git` is missing, the host could not be reached, a download timed out, or an entry that Namzu does not install (`npm`, `command`) |
| 75 | a yes is needed and none can be asked |
| 77 | the folder is not trusted, or `plugins.blockedMarketplaces` refuses the marketplace |

## Update, uninstall, prune

`update <id>` reads the plugin again from where it came from (its marketplace's
catalog, downloading it again when it is a remote one, or the folder it was
uploaded from), builds the new preview and marks
what changed (`1 new hook`, `1 script changed`, `1 local server removed`). Every scope of
the id moves together. If what runs did not change and only a version that the
catalog names did, or the version in `plugin.json` did and nothing that runs
differs (the same surface and only manifests or files that cannot run changed),
it applies after printing the summary. Otherwise it shows the
preview and asks as `install` does. The old folder stays, marked
`.orphaned_at`, so a conversation that has it open keeps its files; `prune` takes
it a day later. A version that kept its number but changed is refused up front, before any
preview or question and with or without `--yes` (exit 65): ask the author to
raise it. A script that was edited counts once, as changed.

`uninstall <id>` removes the record for one scope, its recorded yes, and, when
no other scope needs them, the install manifest and the copy. The plugin's data
(`plugins/data/<id>/`) is kept and stamped with where it came from, unless
`--delete-data`; a later install of the same id from another source warns and
needs `--yes`. A folder you placed by hand in `.namzu/plugins` is yours to
remove (exit 64). With several scopes, `--scope` says which. A project-scope
plugin edits the shared `.namzu/settings.json`: in a terminal you choose to remove
it for everyone or turn it off for yourself only; with no terminal it needs
`--yes`.

`prune` removes copies no record names (what a crash left), install manifests
no record names, staging leftovers older than an hour, and older versions
replaced more than a day ago. It asks, or takes `--yes`; `--dry-run` lists.
Nothing is ever removed on a timer: only this command.

## When something stops half way

The writes of an install run in one order, under one lock, so another Namzu
process never sees half of it: the folder, then the manifest, then the record,
then the recorded yes. A crash at any point leaves at worst a folder or a
manifest that no record names, which the next install of the same plugin
replaces and `prune` removes; a record never points at a folder that is not
there. Removing runs the other way round: the record goes first, the copy last.
An error that is not a crash (a full disk) is cleaned up as far as it can be.
If `installed_plugins.json` cannot be read, every command stops with
`The install record could not be read, so nothing was changed` and names the
file and a recovery copy; no folder is removed.
