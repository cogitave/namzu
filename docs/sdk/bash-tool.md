---
type: Reference
title: The bash tool
description: Which shell the builtin bash tool runs a command in, on the host and in a sandbox, what it strips from the environment, and how the permission rules follow that choice.
resource: packages/sdk/src/tools/command-shell.ts
tags: [sdk, tools, bash, permissions, sandbox]
status: stable
generated: { by: process:claude-code, at: 2026-09-23T00:00:00Z }
---

# The bash tool

`BashTool` (`packages/sdk/src/tools/builtins/bash.ts`, name `bash`) runs one command line and returns its output. Its `command` argument is its `commandArgument`, so permission rules read it as the commands it runs ([How command lines are read](command-lines.md)). That reading is only right for the shell that runs the line, and the tool is built so the two cannot differ.

# Which shell runs the command

On the host the shell is resolved once per process (`hostCommandShell`, `packages/sdk/src/tools/command-shell.ts`):

1. `NAMZU_BASH_SHELL`, when set, names the shell outright. `NAMZU_BASH_SHELL=/bin/sh` restores the shell the tool used before it ran bash.
2. Otherwise the first `bash` in an absolute `PATH` directory, then `/bin/bash`, then `/usr/bin/bash`.
3. With no bash, `/bin/sh`.

The command runs as `<shell> -c <command>`: non-interactive, not a login shell, no startup files. bash in its default mode, not POSIX mode. On Windows the tool keeps Node's platform shell.

bash reads one startup file even non-interactively, the one `BASH_ENV` names, and it takes shell functions (`BASH_FUNC_*`) and parser options (`SHELLOPTS`, `BASHOPTS`) from its environment. Each of those could change what a line means after the rules read it: a function named `git` makes `git status` run something else, and `BASHOPTS=extglob` changes how `!(…)` parses. So they are removed from the environment of the spawned bash, together with `ENV`. `/bin/sh -c` never read them, so a command sees the same environment it did before, minus variables only bash acted on.

Background jobs (`run_in_background`) run in the same shell (`packages/sdk/src/runtime/jobs/registry.ts`).

# In a sandbox

A sandbox runs the guest's own binaries, and a microVM or Kubernetes image may have no bash. The tool passes the guest `/bin/sh -c '<launcher>' sh '<command>'`, where the launcher runs `bash -c` when `command -v bash` finds one and `/bin/sh -c` when it does not (`sandboxShellSpawn`). The command travels as an argument and is never spliced into the launcher's text. The startup variables above are dropped from the `env` the tool hands the sandbox; the guest's environment is otherwise the sandbox's allowlist. A background job in a sandbox (`Sandbox.spawnDetached`) goes through the same launcher.

# How the rules follow the choice

`ToolDefinition.commandDialect` says which dialect a tool's command line is read in. The bash tool answers:

| Where it runs | Shell | Dialect |
|---|---|---|
| Host with bash | `bash -c` | `bash` |
| Host without bash, or `NAMZU_BASH_SHELL` naming a shell that is not bash | `/bin/sh -c` | `sh` |
| Sandbox, including a call approved to leave it | bash if the guest has it, else `/bin/sh` | `sh` |

In the `sh` dialect every construct bash and a POSIX shell such as `dash` read differently makes a line opaque: `$'…'`, `$"…"`, `|&`, `&>`, `&>>`, `<<<`, `;&`, `;;&`, arrays and `+=`, `[[`, `((…))`, `$[…]`, `for ((…))`, `select`, `function`, `coproc`, `time`, brace expansion, `{fd}>` redirections, bash-only `${…}` forms, and a few quirks of bash's line handling. An opaque line is never approved by an allow rule or a skill's `Bash(<pattern>)` entry, so it goes to review. A line that is not opaque means the same in either shell, which is why a sandboxed line can be read in `sh` without knowing what the guest has.

The query executor asks the tool for its dialect on every call it authorizes, with `sandboxed` true whenever the turn has a sandbox (`ToolExecutor.commandDialect`), and passes it to the gate (`ToolCallContext.commandDialect`) and to skill grants (`SkillGrantSet.coveringSkill`). A caller of `AuthorizationGate` or `evaluateRule` that does not pass one gets `sh`.

# Timeouts and output

`NAMZU_BASH_TIMEOUT_MS` sets the default timeout (two minutes) and `NAMZU_BASH_MAX_TIMEOUT_MS` the most a call may ask for (ten minutes). `NAMZU_BASH_MAX_BUFFER_BYTES` caps captured output on the host (100 MiB). Inherited credential-shaped variables are withheld from the host command (`packages/sdk/src/tools/env-scrub.ts`); a failed command names the ones it did not get.
