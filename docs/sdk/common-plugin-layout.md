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
| `hooks` | A path to a `.json` file of hook entries, inline events, or a list of both. `hooks/hooks.json` is always read. A path to program code (`.js`, `.mjs`) given directly here is refused for that entry (`hooks-module-refused`), because this field names a file of hook entries, not a module; a module is named in `hooks/hooks.json`'s `modules` list (see [hooks modules](#hooks-modules)). A folder that ships hooks or servers with no manifest is refused (`manifest-required`). |
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
  A Namzu `plugin.json` keeps its own, lower caps (20 skills, 5 servers, 10
  command and 10 agent folders); the higher ones are for this layout only
  (`CommonLayoutManifestSchema`). The reader stops scanning `skills/` once the cap
  is passed. A plugin folder of more than 20,000 files or 256 MiB is refused
  (`too-large`); the reader counts them, without following links.
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
file other than `hooks/hooks.json` with a `modules` list is
`hooks-modules-refused` for that file (a module is read from the conventional
file only), and its plain entries still load. An event Namzu does not have is
`hook-event-unknown` (ignored).

### Hooks modules

`hooks/hooks.json` may carry `"modules": ["./mod.js"]` beside (or instead of)
its `hooks` events. The one path is relative to the folder of the hooks file, so
`hooks/mod.js` here; a second entry is refused (`hooks-modules-refused`: "names
one hooks module per plugin; a second entry is refused"), as is a path that
leaves the plugin, an absolute path, a link and a file over 1 MiB. The module
exports `register(on, options)`:

```text
export function register(on, options) {
  on('classic.PreToolUse', { tool: 'Bash' }, ($, e, next) => {
    if (e.command?.includes('rm -rf')) return { deny: 'no recursive removal' }
    return {}
  })
}
```

A module in the common layout is **isolated**: it runs in a `worker_threads`
Worker of its own, one per plugin, inside a `node:vm` context that has the
language's builtins and `console`, and no `require`, no `process`, no timers, no
network and no web classes (`URL`, `TextEncoder` and `AbortController` are not
there). Nothing the worker made is handed to the module: `$`, `console`, the
event, `next`, its signal and the errors it catches are made by a script that
runs inside the context, and the worker talks to it in text only, so no object
the module can reach has the worker's `Function` behind its `constructor`. The
context has no prototype on its sandbox and cannot make code from text, the
worker's own function constructors throw, and the scan refuses the names a
script climbs to a constructor with (`constructor`, `__proto__`,
`getPrototypeOf` and the like). This is a worker thread, not a process
boundary, and it is not a promise against a flaw in V8 itself; what bounds a
module is that the person is told what it does first (the trust screen
and `namzu plugin validate` list its events and whether it runs commands, reads
files or uses the network) and that `plugins.enabled` and the person's saved yes
decide whether the plugin is on at all. A Namzu plugin's own `hooks` modules
(`plugin.json` with a `.js` path, exporting a `hooks` array) are unchanged and
still run in the process.

The worker starts when the first event the module hooks arrives, and ends when
the plugin is disabled, uninstalled or the session ends. It has 256 MiB of heap
and an empty environment. A `.ts` or `.mts` module has its types erased with
`stripTypeScriptTypes` from `node:module` (Node 22.13 or later; on an older Node
the module is refused with a message saying so); `.tsx` and `.jsx` are refused,
and nothing is type-checked.

**Reading before running.** The module and the files it imports by relative path
(`import { x } from './x.js'`, at most 64 files, 8 MiB) are parsed with `acorn`
and never run at that stage. The scan lists the patterns registered, whether each
has a matcher or `.catch`, and the calls on `$`, and refuses (naming file and
line): a dynamic `import()`, a top-level `await`, an import of anything but its
own files (`node:fs`, a bare package, the types package as a value), an `on` call
whose event name is not a string literal or whose hook is not a function declared
at the top of its file (or imported from one), an unknown event name, a glob that
selects no event, a repeat of one pattern with no matcher, `on` or `$` used other
than as `on("<event>", hook)` and `$.noun.event(...)`, `$.env.get` with a computed
name, a syntax error and a missing `register`. A refused module does not run; the
plugin's plain hook entries and its other parts still load.

**Events.** `on(pattern, [matcher], hook)` takes `classic.<Event>` for every
settings-style event Namzu has a name for (the PascalCase names a command hook
sees as `hook_event_name`: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`,
`SessionStart`, `Stop`, `PreCompact` and the rest of `SHELL_HOOK_PASCAL_EVENT_NAMES`),
the globs `*` and `classic.*`, and a negation `!x`. Patterns that belong to the
other engine's internals (`tool.call`, `tool.check`, `ui.*`, `engine.create`,
`agent.spawn`, `turn.step`, `process.spawn` and the other non-classic names), and
classic events Namzu has no event for (`Setup`, `ConfigChange`, `MessageDisplay`),
are accepted at registration and never run: they are findings at level `notUsed`
("Namzu runs classic.* hooks from modules; tool.call is not available."), so a
module that also uses classic hooks still works. A matcher is an object of
fields of `e`: a scalar is `===`, a `RegExp` tests the value as text, an array
matches any element, an object is a partial of an object. Registrations nest in
order, first outermost; a hook calls `next(e)` to reach the one beneath, and
returning nothing is a failure.

**What a hook is shown and what it returns.** `e` is what a command hook reads on
stdin (the same fields, built by the same function), frozen to every depth; for
`classic.PreToolUse` it is the tool call itself: `{ tool, tool_use_id, ...the
tool's arguments }`, with the written tool name (`Bash`). A hook's answer is
turned into the JSON a command hook would print and read by the same code, so the
same answer has the same effect from either: `{ allow: true }`, `{ ask: text }`,
`{ deny: text }`, `{}` (decides nothing), `updatedInput` and `additionalContext`
(a list of text) on `classic.PreToolUse`; `block`, `preventContinuation`,
`stopReason`, `additionalContext`, `watchPaths`, `updatedToolOutput`, `decision`
(a permission request) and `permissionDecision` on the other events that read
them. An answer of the wrong shape is a failure. `sessionTitle`,
`suppressOriginalPrompt`, `initialUserMessage`, `reloadSkills`, `retry`,
`displayContent` and `worktreePath` have no counterpart in Namzu and are
ignored.

**Budgets and failure.** A dispatch has 10 seconds of the module's own time (the
clock stops while it waits on a call on `$`, but a dispatch may take no more than
six times the budget, 60 seconds, in all, and the worker is ended at that point
and the programs it started are killed); past the budget the hook is told through
`next.signal`, its `.catch` has one more second to answer, and then the dispatch
fails. A throw, an answer of the wrong shape and returning nothing also fail,
unless the hook's `.catch` answers. A failure is closed in the event's own way:
on `pre_tool_use` the hook's result is `error` and the call is refused with the
reason, on `pre_skill_shell_command` the command is refused, and on every other
event the answer is `continue` with a notice. (The other engine treats a failed
hook as absent; Namzu refuses the guarded call instead.) A worker that does not
answer within the grace is ended and starts again on the next event. When a turn
is cancelled the hook is told, and a worker that has not answered a second later
(a hook stuck in a loop) is ended the same way. A module
that throws as it loads or registers nothing is unloaded with a message, once;
other plugins keep running.

**`$`.** `$.plugin.root` and `$.plugin.name`; `$.store.get`, `set`, `delete` and
`keys` (JSON in `hook-module-store.json` in the plugin's data folder, 1 MiB at
most); `$.fs.read`, `exists`, `stat` and `list` (inside the plugin folder and the
project, through links resolved, 4 MiB a read); `$.process.run(argv, init)` (an
argument list, never a shell line, in the project folder, 30 seconds by default and
10 minutes at most, 4 MiB of each output; the program gets the basic environment
(`PATH`, `HOME`, locale, temporary folder) and the variables the module reads with
`$.env.get`, not the rest of Namzu's environment, and is killed when the
dispatch ends; the listing says "runs commands", and a module that runs `sh` has
a shell like any program has);
`$.env.get('NAME')` (only a name written out as a string literal); `$.ui.log` and
`$.http.fetch` (through the host; the listing says "uses the network"). Every
other noun or method (`$.tool`, `$.fs.write`, `$.session`, ...) is listed by the
scan as not used and throws "`$.x.y is not available in Namzu`" where it is
called. `console.*` goes to the debug log. `options` is empty until a plugin can
ask for saved options.

The SDK exports `scanHookModule`, `locateHookModule`, `startHookModule`,
`summarizeHookModule` and `hookModuleConsentEntry`; the last returns the entry
(plugin, module, one line per thing it does) a consent surface shows, and the
plugin manager takes a `hookModuleFor` callback that starts the module when the
plugin is enabled and ends it when the plugin is turned off.

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
| `url`, with `type` `http`, `sse` or `streamable-http`, or alone | A remote server: parsed and listed in `manifest.remoteMcpServers`. The reader never connects. A host connects it only after the person approves that server (the CLI: the `plugins` section of `mcp-approvals.json`, keyed by plugin id and server name, tied to address, headers and transport) and only while the plugin is on. `headers` may name `${VAR}`, which stays as written and is read when it connects; sign-in uses the host's saved sign-in store. |
| `command` and `url` | Refused for that server (`mcp-server-both`). |
| Neither | Ignored (`mcp-server-empty`). |

Path names are expanded in `command`, `args`, `env`, `url` and `headers`. In an
`env` value only, a bare `${VAR}` is read from the environment. An unset
variable, a `${VAR}` anywhere else, or a path name with no folder marks the
server `needs setup` and it is not started (`mcp-needs-setup`; the finding's `server` field says whether it is `local` or `remote`, and a plugin whose only content is such a remote server still loads and lists it). Any other
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
