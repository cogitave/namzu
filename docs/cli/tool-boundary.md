---
type: Reference
title: Where tools run
description: The CLI runs shell commands and file tools on the host under the permission system by default; a path outside the working directory is an approval request, the OS sandbox is opt-in, and a sandboxed command can leave it only with an approval asked every time. Includes WSL.
resource: packages/cli/src/context/sandbox.ts
tags: [cli, sandbox, permissions, files, wsl]
status: stable
generated: { by: process:claude-code, at: 2026-09-22T00:00:00Z }
---

# Where tools run

By default the CLI runs the model's tools **on this machine**, the way other coding agents do, and the permission system decides what runs. The OS sandbox is an opt-in for an operator who wants commands confined.

## The default: host execution under the permission system

- **Shell commands** run in the host shell, with the shell's environment minus credential-shaped variables. Each one goes through the permission rules and the permission mode: in `prompt` mode it is shown to you first.
- **File tools** (`read`, `write`, `edit`, `glob`, `grep`, `ls`, `lsp`) reach the working directory and the [added directories](add-dir.md) directly. A path **anywhere else is an approval request, not a refusal**: the call is shown to you with the line `Outside the working directory: <path>`, and runs only if you approve it. An approval covers that call and that path, nothing after it.
  - The question is asked even for a tool that only reads, and even where an `allow` rule, a remembered "allow", an earlier "allow all tools for this session" or the `auto` mode (`--yolo`, `--dangerously-skip-permissions`) covers the tool: those were answers about tools, given before this path was named. A prompt that holds such a path offers "allow other tools for this session (not paths outside it)", and an "allow all" answered on another prompt never settles a queued one.
  - A `deny` rule still refuses the call without asking; `strict` and `plan` refuse it like any other change.
  - **With nobody to ask** (a headless `namzu run`, a drained turn) it is refused, not approved: the model is told to name the directory it needs, and the operator adds it with `--add-dir` or `additionalDirectories`.
  - Each answer is written to the session's audit trail as an `outside_root_access` record with the path and outcome `approved` or `refused`.
- `/add-dir <path>` adds a directory for the rest of the session so the tools reach it without asking. For a directory outside the working directory it **asks you first**, decided after links are followed: `./link` pointing outside is asked about under the path it leads to.

The startup notice says `Sandbox off (the default)` and names the key that turns it on.

## Opting in: `sandbox.enabled: true`

```json
{ "sandbox": { "enabled": true } }
```

With the sandbox on, each command runs confined to the working directory and the added directories (read-write), with the network cut where the platform can cut it (on Linux, `bwrap --unshare-all`). Under `bwrap` the command also sees the system directories and the Node runtime read-only, `/proc`, `/dev` and a private `/tmp`; a tier that cannot confine the file system (`linux-namespace`, `basic`) says so at startup and in the model's prompt. What the machine enforces is reported at startup, and `sandbox.requireIsolation` refuses to start when a named control cannot be enforced. The sandbox is the same strength it was: file tools resolve inside it, and a path it does not mount is refused.

`sandbox.enabled` is on without being written when `sandbox.requireIsolation` names a control or `sandbox.workspace` is `ephemeral`, because both only mean something inside a sandbox. `sandbox.enabled: false` turns it off even then.

### Leaving the sandbox for one command

A sandboxed `bash` call can set `dangerously_disable_sandbox: true` to run that one command on the host (it needs the network, a path the sandbox does not mount, or a host tool). The request is:

- **asked about every time**, in every permission mode that does not refuse it — `auto`, `--yolo` and an earlier "allow all" included. The prompt says `Runs OUTSIDE the sandbox, on this machine`, and its second choice reads "allow other tools for this session (not sandbox escapes)". An "allow all" answered on one prompt never settles a queued escape that was not on screen.
- **refused in a turn with nobody to ask** (a headless `namzu run`, a drained turn) unless `sandbox.allowUnattendedEscape: true`.
- **refused in `plan` and `strict` mode**, like any other change.
- **recorded** in the audit trail as a `sandbox_escape` record, `approved` or `refused` — a refusal by the person, by the headless default, or by a policy that did not confirm it.
- **never combined with `run_in_background`**: a host job would outlive the approval given for one call.

| Key | Default | Meaning |
| --- | --- | --- |
| `sandbox.enabled` | `false` (see above) | Confine commands in the OS sandbox. |
| `sandbox.allowEscape` | `true` | Allow a sandboxed `bash` call to ask to leave the sandbox. `false` refuses every such request. |
| `sandbox.allowUnattendedEscape` | `false` | Grant that request without a prompt when nobody can be asked. |

## What the model is told

The environment block in the system prompt states the boundary, so the model does not have to infer it from refusals: whether tools run on the host or in a sandbox (and what the sandbox enforces), that a path outside the working directory is asked about rather than refused (or, with nobody to ask, refused and named so `--add-dir` can add it), what a sandbox that confines the file system still shows a command, `/add-dir` for a directory it needs repeatedly, and — only in a sandboxed session that allows it — the per-command escape. A refusal a file tool still returns names the way to widen the boundary instead of ending at "may only reach".

## WSL

On Windows Subsystem for Linux (detected from `WSL_DISTRO_NAME` or `WSL_INTEROP`) the model is also told:

- the Windows drives mounted under `/mnt/<letter>` (`C:\Users` is `/mnt/c/Users`; `wslpath` converts), and that a file tool reaching them asks first like any other outside path;
- that Windows programs start from the shell through WSL interop by their `.exe` name — `powershell.exe -NoProfile -Command ...`, `cmd.exe /c ...` — and that `cmd.exe` started from a Linux directory warns about UNC paths and falls back to `C:\Windows`;
- when interop is off (no `WSL_INTEROP` and no `/proc/sys/fs/binfmt_misc/WSLInterop`), that `.exe` programs cannot be started;
- in a sandboxed session, that the drives and the programs on them are not mounted, so they need `/add-dir` or the escape.

## Upgrading from the sandboxed default

The previous CLI turned the sandbox on unless `sandbox.enabled: false` was written. To keep that behaviour, write `sandbox.enabled: true` in `namzu.config.json` or `~/.namzu/config.yaml`. A config that already had `sandbox.enabled: false` behaves as before, except that a path outside the working directory is now asked about instead of refused when someone is at the terminal (a headless turn still refuses it).
