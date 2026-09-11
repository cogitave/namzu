---
type: Reference
title: Plugins in the CLI
description: Load trusted Namzu plugins and inspect or change their contributions through the session menu.
resource: packages/cli/src/integrations/plugins/runtime.ts
tags: [cli, plugins, tools, skills, hooks]
---

# Plugins in the CLI

Namzu's SDK plugin runtime is connected to the CLI. A plugin can contribute
tools, skills, JavaScript hooks and stdio MCP servers. The CLI runs its plugin
runtime in the main agent session; delegated agents have independent registries
and do not inherit executable plugins.

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
  "skills": ["skills/reconcile"]
}
```

If both locations resolve to the same physical plugin directory, it is treated
as user scope and scanned once. A project-only configuration does not admit that
shared user directory. Sharing an application root alone does not merge two
different plugin directories.

That skill directory contains `SKILL.md` with a `name` and `description` in YAML
frontmatter. Its registered name is `ledger__reconcile`. Tools and hooks declare
JavaScript module paths; MCP servers declare their stdio command, optional
arguments and environment. `connectors` and `personas` in plugin manifests are
not supported and are refused rather than ignored.

Review executable plugins before enabling loading: module imports and hooks
execute in the CLI process, and MCP servers start child processes. Tool approval
is not a sandbox for plugin startup code. Project trust and admitted scope roots
still apply. Refused manifests stop plugin startup and roll back already loaded
contributions. Namzu does not install another application's plugin format or
download a marketplace through this menu.

## Inspect and control the session

- `/plugins` opens a searchable list of loaded plugins. Select one to view
  details or enable/disable it for this session.
- `/plugins list` prints the current roster.
- `/plugins <name>` prints one plugin's full directory, version, scope and
  contributions. `/help plugins` explains the command without running it.

Opening the menu does not scan directories, import code or call a model.
It reads the current session's runtime. When loading or discovery is off, or
there are no loaded plugins, the report explains the state and shows full
configuration and admitted plugin directory paths.

Tool and skill lists are registered runtime contributions. Hook modules and
MCP server names are explicitly labelled as manifest declarations; a declaration
does not establish a live MCP connection. MCP environment values and hook bodies
are not included in the operator snapshot.

Choose **Disable for this session** to remove a plugin's tools, skills and hooks
and disconnect its MCP servers. **Enable for this session** registers them again
using the existing SDK lifecycle. A failed change is reported and the menu reads
the runtime's resulting state. Changes require an idle session: the host refuses
them during sends, compaction or durable resume, and refuses new invocations
while a change is settling. Closing the session waits before releasing resources.

These changes do not edit configuration or delete plugin files. They reset when
Namzu restarts or a model/provider switch reconstructs the session. Already
recorded conversation history is retained. To change the installed plugin files
or loading configuration, make the change and restart Namzu.
