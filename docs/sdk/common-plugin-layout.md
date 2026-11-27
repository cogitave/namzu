---
type: Reference
title: The common plugin layout
description: How the SDK reads a plugin folder written in the layout other tools share - which file speaks, every field and what becomes of it, the findings it reports, and what it refuses.
resource: packages/sdk/src/plugin/common-layout/
tags: [sdk, plugins, layout, mcp, skills, hooks]
generated: { by: "claude-sonnet-5", at: "2026-11-27" }
---

# The common plugin layout

Plugins written for other tools share one on-disk shape: a manifest in a folder
of its own, and conventional folders for skills, commands, agents, hooks and
servers. `@namzu/sdk` reads that shape so a folder made for it runs here
unchanged, without Namzu adopting its names: a plugin's skills are still
`<plugin>__<skill>`, its commands `/<plugin>__<command>`, and every Namzu-facing
path and variable keeps its own name. The file and variable names of the other
shape are compatibility literals kept in one source file,
`packages/sdk/src/plugin/common-layout-names.ts`.

The reader is `readCommonLayout(root, options)`. It is pure: it reads inside the
folder, never follows a symbolic link, imports and runs nothing, and opens no
connection. It returns the manifest Namzu would admit, the remote servers it
found, and a finding for everything it used, left out or refused.

## Which file speaks

In this order, the first that applies decides:

1. A Namzu `plugin.json` at the folder root. The reader says only that it was
   there (and, when a common manifest is beside it, reports `manifest-both`: the
   `plugin.json` is used and the other is ignored). The loader reads it as it
   always has.
2. The common manifest.
3. The install sidecar `.namzu-entry.json`, only when `options.entrySidecar` is
   set. See [the sidecar](#the-install-sidecar).
4. A root `SKILL.md` and nothing else: a one-skill plugin named after the
   folder.
5. The conventional folders alone (`skills/`, `commands/`, `agents/`, `hooks/`,
   a root servers file), with the plugin named after the folder.

A folder with none of them is refused (`not-a-plugin`).

## Where it applies

- **The loader.** `loadPluginManifest(dir)` reads a `plugin.json` when there is
  one, and otherwise falls back to the reader, so `--plugin-dir`, an install by
  path and a folder placed by hand all load a common-layout plugin. A refused
  plugin throws with the reason. `loadPluginManifestWithFindings` also returns
  the findings.
- **Discovery.** `discoverPlugins` admits a folder whose manifest is the common
  one, as well as one with a `plugin.json`. A folder that has only conventional
  folders and no manifest is not found by scanning: something that runs needs a
  manifest or a person naming the folder. Naming it (`--plugin-dir`, an install)
  does load it.
- **The lifecycle.** `PluginLifecycleManager.install(dir, scope, { authorityRoot, manifestSource })`
  takes a manifest the caller already read. It is validated again and the folder
  is still resolved inside the authority root; only the reading is skipped.
  `layoutFindings(id)` returns what the reader found.
- **Checking.** [`namzu plugin validate`](../cli/plugin-validate.md) shows the
  findings of a folder with no `plugin.json`.

The manifest the reader returns carries `layout: 'common'`. The schema never
reads that key, so a `plugin.json` cannot claim it.

## Fields

| Field | What becomes of it |
|---|---|
| `name` | Required, lowercase words joined by dashes, 64 at most; otherwise the plugin is refused (`name-invalid`). |
| `version` | Kept. Absent: `options.version`, else `0.0.0+<8 hex digits of what the plugin holds>`. |
| `description` | Kept. Absent: the first line of `README.md` that is not a heading (300 characters at most), else `options.description`, else `(no description)`. |
| `author` | An object becomes `Name <email>`; a string stays. |
| `displayName`, `homepage`, `repository`, `license`, `keywords`, `metadata`, `$schema`, `icon`, `connectors`, `personas`, `optionalDependencies` | Ignored (`manifest-metadata`): they never run. |
| `defaultEnabled` | Ignored: Namzu turns a plugin on only after a recorded yes. |
| `engines`, `platforms` | `engines.namzu` and `platforms` are honoured by the loader's compatibility check; other engines are dropped. |
| `skills` | Folder paths added to the auto-scanned `skills/`. `"."` is one skill only when `SKILL.md` is there. |
| `commands`, `agents` | A folder or a single `.md` file, a list of them, or the object-map form with `source`. Inline `content` is refused for that entry (`inline-text-unsupported`). Naming any stops the folder being scanned on its own and reports `folder-shadowed-by-manifest`. With none named, `commands/` and `agents/` are scanned. Agent frontmatter keys Namzu does not read are reported per file (`agent-key-ignored`). |
| `hooks` | A path, inline events, or a list of both. `hooks/hooks.json` is always read. |
| `mcpServers` | A path, an inline map, or a list of those, plus the root servers file. See [servers](#servers). |
| `dependencies` | Each must already be installed (`options.installedIds`), else the plugin is refused (`dependency-unmet`); nothing is installed for you. |
| `userConfig` | Not supported yet (`user-config-unsupported`). A server that names `${user_config.X}` is not started. |
| `outputStyles`, `themes`, `workflows`, `monitors`, `channels`, `lspServers`, `binaries`, `settings`, `types`, `network`, `experimental`, and the folders `output-styles/`, `themes/`, `monitors/`, `workflows/`, `bin/` | Reported as not used, with the item count. `settings` and `binaries` say so loudly, and `network` shows what the plugin says it reaches. |
| Any other key | Ignored (`manifest-unknown-key`). |

A plugin with nothing usable left is refused: `Nothing in <name> is used by Namzu
(it only has: themes).`

## Skills, commands, agents and folders

- `skills/<dir>/SKILL.md` is read for each direct subfolder, in name order. A
  subfolder with no `SKILL.md` is `skill-no-file` (ignored). A skill the skill
  reader refuses is `skill-invalid` (refused) for that skill alone; the rest load.
- `.git`, `node_modules`, `__MACOSX` and any folder starting with a dot are never read.
- A symbolic link inside the plugin is never followed and is reported
  (`symlink`). A path the manifest names that is absolute, holds `..`, or goes
  through a link refuses the whole plugin (`path-escapes`).
- At most **64 skills**, **64** command sources and **64** agent sources, and
  **16 servers** (local and remote together). More refuses the plugin
  (`too-many-skills`, `too-many-commands`, `too-many-agents`, `too-many-servers`).
  The same caps now apply to a Namzu `plugin.json`: skills went from 20 and
  servers from 5, and command and agent folders from 10.
- `findCommonLayoutRoot(dir)` is for a folder unpacked from an archive: one
  wrapping folder is descended into when it holds the manifest folder or a
  recognised component; `__MACOSX` and `.DS_Store` are ignored.

### Text and paths

`${NAMZU_PLUGIN_ROOT}` (and the layout's own spelling of it) in a plugin skill's,
command's or agent's text is replaced with the plugin's absolute folder when the
text is read, for every plugin, not only common-layout ones. `${user_config.*}`
is not replaced.

`expandPluginPaths(text, { root, data?, project? })` replaces exactly six names:
the plugin folder, the plugin's data folder and the project folder, each in
Namzu's spelling and the layout's. Nothing else is touched, no shell runs, and a
folder that is not absolute or holds a NUL is refused. A name with no folder is
left as written and reported in `unresolved`.

### Hooks

Hook entries are read by the CLI as before; the reader adds findings. A hooks
file with a `modules` list is `hooks-modules-refused` for that file (it runs
plugin code at startup), and its plain entries still load. An event Namzu does
not have is `hook-event-unknown` (ignored).

A hook of a plugin read through this layout also gets three environment names
set in its process, with the same values as the Namzu ones: the plugin folder,
the plugin data folder and the project folder, so a script the hook starts finds
them under the names it was written for. A Namzu plugin's environment is not
widened.

## Servers

The root servers file is read in both forms, `{ "mcpServers": { name: spec } }`
and the flat `{ name: spec }`; the manifest field may be a path, an inline map or
a list of them. A `.mcpb` or `.dxt` bundle is ignored.

| Entry | Result |
|---|---|
| `command` (with `args`, `env`), no `type` or `type: "stdio"` | A local server, started while the plugin is on. Other keys (`cwd`, `timeout`) are ignored per key. |
| `url`, with `type` `http`, `sse` or `streamable-http`, or alone | A remote server: parsed, listed in `manifest.remoteMcpServers`, and **not started**. Nothing connects to it yet. `headers` may name `${VAR}`, which stays as written. |
| `command` and `url` | Refused for that server (`mcp-server-both`). |
| Neither | Ignored (`mcp-server-empty`). |

Path names are expanded in `command`, `args`, `env`, `url` and `headers`. In an
`env` value only, a bare `${VAR}` is read from the environment. An unset
variable, a `${VAR}` anywhere else, or a path name with no folder marks the
server `needs setup` and it is not started (`mcp-needs-setup`). Any other
`$NAME`, backtick or `%NAME%` is left as written and reported
(`mcp-text-left-as-is`). A relative `command` with `..` is refused for that
server. An address must be `http` or `https` and hold no user name or password.

The remote form is also accepted in a Namzu manifest as `remoteMcpServers`.

## The install sidecar

`.namzu-entry.json` holds the allow-listed fields of a marketplace entry that an
install wrote beside the plugin (`name`, `description`, `version`, `author`,
`strict`, and the component fields). The reader opens it only when the caller
passes `entrySidecar: true`, which only code holding an install record for that
folder does. A folder placed by hand, a repository, and anything found by
scanning are read without it, so none of them can inject hooks or servers
through it. With `strict: false` the entry's fields win over the manifest's;
otherwise it only fills in missing name, description, version and author and its
component fields are ignored (`entry-inline-ignored`).

## Findings

Every finding has `level`, `code`, `field`, `message` and, when a file is
meant, `path`.

| Level | Meaning |
|---|---|
| `used` | Namzu reads and uses it. |
| `ignored` | Harmless or unread: details only. |
| `notUsed` | A feature Namzu has no place for: shown at install and in details; the plugin still loads. |
| `refused` | Dropped. At entry level (one server, one skill, one hooks file) the plugin loads without it. At plugin level the plugin does not load; `refusal` names the finding. |

Plugin-level refusals: `root-not-directory`, `not-a-plugin`, `manifest-invalid`
(not JSON, not an object, or over 256 KiB), `name-invalid`, `dependency-unmet`,
`path-escapes`, `too-many-*`, `nothing-used`, and an `engines` or `platforms`
mismatch reported by the loader.
