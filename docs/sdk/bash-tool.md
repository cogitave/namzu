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

1. `NAMZU_BASH_SHELL`, when set, names the shell outright. `NAMZU_BASH_SHELL=/bin/sh` restores the shell the tool used before it ran bash. On Windows, `NAMZU_BASH_SHELL=cmd` (or a path to `cmd.exe`, so `%ComSpec%` works) keeps cmd.exe.
2. Otherwise the first `bash` in an absolute `PATH` directory, then `/bin/bash`, then `/usr/bin/bash`.
3. With no bash, `/bin/sh`.

On Windows the order is different, because the `bash` on a Windows `PATH` can be WSL's launcher, which runs the command in another system. Git for Windows' bash is looked up in a fixed order (`findGitBash`): `NAMZU_BASH_SHELL`, then `%ProgramFiles%\Git\bin\bash.exe`, then `%ProgramFiles(x86)%\Git\bin\bash.exe`, then the per-user install `%LOCALAPPDATA%\Programs\Git\bin\bash.exe` (skipped when `LOCALAPPDATA` is unset), then the install that holds the first `git` that `%SystemRoot%\System32\where.exe git` lists (its `bin\bash.exe`, one or two directories above the `git.exe`). A `git.exe` found inside the working directory is skipped, so a repository cannot plant the program that runs. Nothing is read from the registry and `where bash` is never asked. Without Git for Windows the tool falls back to cmd.exe and `windowsShellNotice()` carries the one-time notice shown in the session (`Git for Windows not found — shell commands run in cmd.exe and each one asks for approval. Install Git for Windows for full support.`).

The command runs as `<shell> -c <command>`: non-interactive, not a login shell, no startup files. bash in its default mode, not POSIX mode. On Windows with Git Bash the command runs as `bash.exe -c <command>` and is read in the `bash` dialect; the Windows-only details are below. Without Git Bash the tool keeps Node's platform shell (normally CMD) and reports the explicit `cmd` dialect. The CMD reading is conservatively opaque: command-specific allow rules and skill patterns decline it, and the existing unknown-program escalation requests exact-call review. A whole-tool gate allowance does not bypass this escalation. SDK query prompts disclose each active command tool's execution dialect, including minimal and cached prompts; sandboxed tools describe the guest's `sh` dialect instead of the Windows host.

An application running a confirmed script can select an installed interpreter
explicitly with `installedCommandShellForDialect('bash' | 'sh')`. The matching
`findCommandShellForDialect(dialect, probe)` accepts an injected probe for a
host's own resolution checks. Both return `undefined` when that interpreter
is unavailable; neither substitutes one dialect for the other. Pass the
returned `CommandShell` as `execHostShell(command, { ..., shell })` to use the
same process supervision, output capture and environment handling as the
live bash tool. Resolve it again before a later unattended run, since an
interpreter can be removed after confirmation. Native Windows returns no
explicit POSIX interpreter from these helpers. A matching
`NAMZU_BASH_SHELL` override must name an absolute executable path for an
explicitly selected script shell, so confirmation and fire cannot resolve a
relative name from different working folders.
When no matching override is set, explicit resolution prefers `/bin/bash`
or `/usr/bin/bash` (and `/bin/sh` or `/usr/bin/sh` for `sh`) before looking
through absolute `PATH` directories. This keeps a later `PATH` change from
silently replacing a standard interpreter for a scheduled run.

bash reads one startup file even non-interactively, the one `BASH_ENV` names, and it takes shell functions (`BASH_FUNC_*`) and parser options (`SHELLOPTS`, `BASHOPTS`) from its environment. Each of those could change what a line means after the rules read it: a function named `git` makes `git status` run something else, and `BASHOPTS=extglob` changes how `!(…)` parses. So they are removed from the environment of the spawned bash, together with `ENV`. `/bin/sh -c` never read them, so a command sees the same environment it did before, minus variables only bash acted on.

Background jobs (`run_in_background`) run in the same shell (`packages/sdk/src/runtime/jobs/registry.ts`), started by the same `spawnHostShell`; see [a job that cannot start](../cli/background-jobs.md#a-job-that-cannot-start).

For finite work, `wait_for_job` without an output condition waits for exit.
For a persistent server, set `output_contains` to its exact readiness marker and
optionally `output_stream` to `stdout`, `stderr` or `either`. This bounded
observation can return while the process remains running and never holds a
finishing turn open until exit. It does not establish service health. The
registry API, byte cursors, independent pipe matching, cancellation and explicit
retention gaps are described in [Observing background output](tool-execution.md#observing-background-output).

## Read-only lines

`isReadOnly` and `isConcurrencySafe` of the builtin tool are decided per call from the command line (`isReadOnlyCommandLine`, `authorization/readonly-commands.ts`). A line is read-only when every command in it is on the reference terminal's vetted list and nothing in it is decided at run time. A read-only call runs without review in `prompt` and `accept-edits`, is allowed in `plan`, and runs beside other read-only calls instead of alone.

What is vetted, from the reference (2.1.302):

- Commands that read and print, with any arguments: `cat`, `head`, `tail`, `wc`, `stat`, `ls`, `echo`, `diff`, `du`, `df`, `id`, `uname`, `basename`, `dirname`, `realpath`, `readlink`, `cut`, `tr`, `column`, `sort`-free helpers such as `tac`, `rev`, `fold`, `fmt`, `nl`, `od`, `hexdump`, `strings`, `cmp`, `comm`, `paste`, `which`, `type`, `seq`, `sleep`, `true`, `false` and the rest of that list.
- Commands with fixed shapes: `pwd`, `whoami`, `alias` (no arguments), `cd` (one), `history [N]`, `arch [-h]`, `ifconfig [iface]`, `ip addr`, `node -v`, `python3 --version`, `claude -h`, `docker ps|images` (not pointed at another host or context), `uniq` (flags only), `jq` (not `-f`, `env`, `include`), `find` without `-delete`, `-exec`, `-execdir`, `-ok`, `-okdir`, `-fprint*`, `-fls`, `-files0-from`.
- Commands whose every flag must be in a table with the kind of value it takes: `git diff`, `status`, `log`, `show`, `shortlog`, `blame`, `branch`, `tag`, `ls-files`, `ls-remote`, `cat-file`, `describe`, `for-each-ref`, `grep`, `merge-base`, `reflog`, `remote`, `remote show`, `rev-list`, `rev-parse`, `stash list`, `stash show`, `worktree list`, `config --get`; `grep`/`egrep`/`fgrep`, `rg`, `file`, `sort`, `tree`, `base64`, `sha256sum`/`sha1sum`/`md5sum`. A flag in no table refuses the line, which is why `git diff --output=f`, `git -c k=v status`, `--exec-path` and `--config-env` are never read-only, and why `git fetch` is not on the list. `git branch` and `git tag` are read-only only when listing; a name that would create one is not.

What refuses a line: a `$` outside single quotes, a substitution, a subshell, a group, a background `&`, a here-document, a redirection other than to `/dev/null` or a descriptor copy or an input from a plain file, a `~user` or UNC path, a glob on a command that is not a plain reader, a leading assignment other than the reference's harmless set (`LANG`, `TZ`, `NO_COLOR`, ...), `cd` next to `git`, a program written with a path or in quotes, and a call that runs in the background or leaves the sandbox.

A read-only line is still subject to the path floor: `cat /etc/hosts` outside the roots is asked about. Not ported from the reference: `sed`, `ps`, `lsof`, `ss`, `date`, `man`, `xargs`, `fd`, `gh`, `docker logs|inspect`, `printf`, `[[`, `test`, and its check of the working directory for a planted bare repository.

## Job-exit delivery to a host

A host can pass a session-owned `BackgroundJobRegistry` as
`QueryParams.backgroundJobs` and its session id as `backgroundJobOwner`, so jobs
survive the turn that starts them. Subscribe to the registry's `onExit` to
show an immediate status update and retain each exit for the next turn. The
turn sends a notice on a tool result or a recorded `job-exit` context message
when it can. `QueryParams.onJobNoticeDelivered(jobIds)` acknowledges only
those notices, after they enter the turn's messages. The host can remove the
acknowledged ids from its pending set. An exit after the last delivery point
receives no acknowledgment and should be passed to the next model turn; an
exit event by itself is not proof that the model received it. The [CLI job
view](../cli/background-jobs.md#learning-that-it-ended) uses this handoff.

# In a sandbox

A sandbox runs the guest's own binaries, and a microVM or Kubernetes image may have no bash. The tool passes the guest `/bin/sh -c '<launcher>' sh '<command>'`, where the launcher runs `bash -c` when `command -v bash` finds one and `/bin/sh -c` when it does not (`sandboxShellSpawn`). The command travels as an argument and is never spliced into the launcher's text. The startup variables above are dropped from the `env` the tool hands the sandbox; the guest's environment is otherwise the sandbox's allowlist. A background job in a sandbox (`Sandbox.spawnDetached`) goes through the same launcher.

# How the rules follow the choice

`ToolDefinition.commandDialect` says which dialect a tool's command line is read in. The bash tool answers:

| Where it runs | Shell | Dialect |
|---|---|---|
| Host with bash | `bash -c` | `bash` |
| Windows host with Git for Windows | Git Bash `bash.exe -c` | `bash` |
| Windows host without it, or `NAMZU_BASH_SHELL=cmd` | `cmd.exe /d /s /c` | `cmd` |
| Host without bash, or `NAMZU_BASH_SHELL` naming a shell that is not bash | `/bin/sh -c` | `sh` |
| Sandbox, including a call approved to leave it | bash if the guest has it, else `/bin/sh` | `sh` |

In the `sh` dialect every construct bash and a POSIX shell such as `dash` read differently makes a line opaque: `$'…'`, `$"…"`, `|&`, `&>`, `&>>`, `<<<`, `;&`, `;;&`, arrays and `+=`, `[[`, `((…))`, `$[…]`, `for ((…))`, `select`, `function`, `coproc`, `time`, brace expansion, `{fd}>` redirections, bash-only `${…}` forms, and a few quirks of bash's line handling. An opaque line is never approved by an allow rule or a skill's `Bash(<pattern>)` entry, so it goes to review. A line that is not opaque means the same in either shell, which is why a sandboxed line can be read in `sh` without knowing what the guest has.

The query executor asks the tool for its dialect on every call it authorizes, with `sandboxed` true whenever the turn has a sandbox (`ToolExecutor.commandDialect`), and passes it to the gate (`ToolCallContext.commandDialect`) and to skill grants (`SkillGrantSet.coveringSkill`). A caller of `AuthorizationGate` or `evaluateRule` that does not pass one gets `sh`.

# Timeouts and output

`NAMZU_BASH_TIMEOUT_MS` sets the default timeout (two minutes) and `NAMZU_BASH_MAX_TIMEOUT_MS` the most a call may ask for (ten minutes). `NAMZU_BASH_MAX_BUFFER_BYTES` caps captured output on the host (100 MiB). Inherited credential-shaped variables are withheld from the host command (`packages/sdk/src/tools/env-scrub.ts`); a failed command names the ones it did not get.

## Git Bash on Windows

Reading cmd.exe lines is not possible for the permission rules, so with cmd every command line was "a program decided at runtime" and needed a person in every mode, and a model's POSIX syntax did not run. With Git Bash both go away. What differs from a POSIX host:

- The spawn is hidden (`windowsHide`), not detached, with stdin on the null device, so a command that reads input sees end-of-file instead of waiting for its timeout. The environment gains `GIT_EDITOR=true`, and a unique `NAMZU_SHELL_TAG`.
- A redirect to the Windows null device (`>nul`, `2>NUL`, `&>nul`, `>>nul`) is rewritten to `/dev/null` in the tool's input, before the permission rules read the line and before it runs. In bash `nul` is an ordinary file name, which Windows then cannot delete. A line with `<`, `$` or a backtick is left alone.
- Killing a command ends the whole tree. `taskkill /T /F` alone misses what Git Bash forked, because the process that forked has already exited and the command's Windows parent no longer exists (`sleep 60; echo done` leaves `sleep`). So the kill first finds every process whose environment carries the shell's tag, from inside the msys runtime, and ends them, then runs `taskkill /T /F`.
- The model is told. The system context reads `Execution shell for bash: bash (Git Bash on Windows, host).` and the tool description gains `WINDOWS_BASH_GUIDANCE`: Git Bash (POSIX sh), not cmd.exe or PowerShell; `/dev/null` not `NUL`, forward slashes, `$VAR` not `%VAR%` or `$env:VAR`; to run PowerShell, call `powershell -NoProfile -Command "…"`.
- Paths are the host's: `cwd` is the Windows path and Git Bash shows it as `/c/…` or `/tmp/…`. `!command` in the composer is the operator's own shell and stays on cmd.exe.

## Native Windows metadata migration

`ShellDialect` now includes `cmd`. The native Windows `hostCommandShell().dialect` and unsandboxed `BashTool.commandDialect()` changed from `sh` to `cmd`, and with Git for Windows installed they are now `bash`. To keep cmd.exe on such a machine set `NAMZU_BASH_SHELL=cmd`. Consumers must handle this third value in exhaustive
switches and pass it into authorization reads. Do not relabel CMD as `sh` to
retain previous command-pattern allowances: POSIX single quotes and escaping
can hide commands that CMD executes. Use an exact-call review or an explicitly
selected POSIX interpreter. `NAMZU_BASH_SHELL` remains an explicit POSIX
interpreter override; Windows `bash.exe` and `sh.exe` paths are recognized.
There is no automatic PowerShell or WSL selection (a `powershell` tool for machines without Git Bash is not built). Sandboxed Linux guest
commands continue to be read as `sh` even on a Windows operator device.
