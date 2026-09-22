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
  - The question is asked even for a tool that only reads, and even where an `allow` rule or a remembered "allow" covers the tool: those were written about the tool, not about a path outside the project.
  - A `deny` rule still refuses the call without asking.
  - The permission mode decides as it does for any other reviewed call: `prompt` asks, `strict` and `plan` refuse, and `auto` (`--yolo`, `--dangerously-skip-permissions`, or a headless turn) approves it. Each approval is written to the session's audit trail as an `outside_root_access` record with outcome `approved` and the path.
- `/add-dir <path>` adds a directory for the rest of the session so the tools reach it without asking. For a directory outside the working directory it **asks you first**.

The startup notice says `Sandbox off (the default)` and names the key that turns it on.

## Opting in: `sandbox.enabled: true`

```json
{ "sandbox": { "enabled": true } }
```

With the sandbox on, each command runs confined to the working directory and the added directories, with the network cut where the platform can cut it (on Linux, `bwrap --unshare-all`). What the machine enforces is reported at startup, and `sandbox.requireIsolation` refuses to start when a named control cannot be enforced. The sandbox is the same strength it was: file tools resolve inside it, and a path it does not mount is refused.

`sandbox.enabled` is on without being written when `sandbox.requireIsolation` names a control or `sandbox.workspace` is `ephemeral`, because both only mean something inside a sandbox. `sandbox.enabled: false` turns it off even then.

### Leaving the sandbox for one command

A sandboxed `bash` call can set `dangerously_disable_sandbox: true` to run that one command on the host (it needs the network, a path the sandbox does not mount, or a host tool). The request is:

- **asked about every time**, in every permission mode that does not refuse it — `auto`, `--yolo` and an earlier "allow all" included. The prompt says `Runs OUTSIDE the sandbox, on this machine`, and its second choice reads "allow other tools for this session (not sandbox escapes)". An "allow all" answered on one prompt never settles a queued escape that was not on screen.
- **refused in a turn with nobody to ask** (a headless `namzu run`, a drained turn) unless `sandbox.allowUnattendedEscape: true`.
- **refused in `plan` and `strict` mode**, like any other change.
- **recorded** in the audit trail as a `sandbox_escape` record, `approved` or `refused`.
- **never combined with `run_in_background`**: a host job would outlive the approval given for one call.

| Key | Default | Meaning |
| --- | --- | --- |
| `sandbox.enabled` | `false` (see above) | Confine commands in the OS sandbox. |
| `sandbox.allowEscape` | `true` | Allow a sandboxed `bash` call to ask to leave the sandbox. `false` refuses every such request. |
| `sandbox.allowUnattendedEscape` | `false` | Grant that request without a prompt when nobody can be asked. |

## What the model is told

The environment block in the system prompt states the boundary, so the model does not have to infer it from refusals: whether tools run on the host or in a sandbox (and what the sandbox enforces), that a path outside the working directory is asked about rather than refused, `/add-dir` for a directory it needs repeatedly, and — only in a sandboxed session that allows it — the per-command escape. A refusal a file tool still returns names the way to widen the boundary instead of ending at "may only reach".

## WSL

On Windows Subsystem for Linux (detected from `WSL_DISTRO_NAME` or `WSL_INTEROP`) the model is also told:

- the Windows drives mounted under `/mnt/<letter>` (`C:\Users` is `/mnt/c/Users`; `wslpath` converts), and that a file tool reaching them asks first like any other outside path;
- that Windows programs start from the shell through WSL interop by their `.exe` name — `powershell.exe -NoProfile -Command ...`, `cmd.exe /c ...` — and that `cmd.exe` started from a Linux directory warns about UNC paths and falls back to `C:\Windows`;
- when interop is off (no `WSL_INTEROP` and no `/proc/sys/fs/binfmt_misc/WSLInterop`), that `.exe` programs cannot be started;
- in a sandboxed session, that the drives and the programs on them are not mounted, so they need `/add-dir` or the escape.

## Upgrading from the sandboxed default

The previous CLI turned the sandbox on unless `sandbox.enabled: false` was written. To keep that behaviour, write `sandbox.enabled: true` in `namzu.config.json` or `~/.namzu/config.yaml`. A config that already had `sandbox.enabled: false` behaves as before, except that a path outside the working directory is now asked about instead of refused.
