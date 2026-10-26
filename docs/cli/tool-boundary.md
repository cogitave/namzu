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

By default the CLI runs the model's tools **on this machine**, and the permission system decides what runs. The OS sandbox is an opt-in for an operator who wants commands confined.

## The default: host execution under the permission system

- **Shell commands** run in the host shell, with the shell's environment minus credential-shaped variables. Each one goes through the permission rules and the permission mode: in `prompt` mode it is shown to you first.
- **File tools** (`read`, `write`, `edit`, `glob`, `grep`, `ls`, `lsp`) reach the working directory and the [added directories](add-dir.md) directly. A path **anywhere else is an approval request, not a refusal**: the call is shown to you with the line `Outside the working directory: <path>`, and runs only if you approve it. An approval covers that call and that path, nothing after it.
  - The question is asked even for a tool that only reads, and even where an `allow` rule or a remembered "don't ask again" answer covers the tool: those were answers about tools, given before this path was named. A prompt that holds such a path offers only Yes and No, and an answer given on another prompt never settles a queued one. Two modes answer it differently on purpose: **`bypass`** (`--yolo`, `--dangerously-skip-permissions`) runs the call without asking, and **`auto`** sends it to the classifier ([Permission modes](permission-modes.md)).
  - A `deny` rule still refuses the call without asking, and is recorded as a refused `outside_root_access`. `strict` refuses it, since no rule can approve such a path. `plan` asks about a batch of reads the same way, since reading is what plan mode is for, and refuses a write, edit or command like any other change.
  - **With nobody to ask** (a headless `namzu exec`, a drained turn) it is refused, not approved: the model is told to name the directory it needs, and the operator adds it with `--add-dir` or `additionalDirectories`.
  - Each answer is written to the session's audit trail as an `outside_root_access` record with the path and outcome `approved` or `refused`.
- **Shell commands are read for the paths they name.** `cat /etc/passwd`, `ls ~/.ssh`, `cp a ~/x` and `echo x > ~/.profile` are the same approval request as a `read` outside the project: the command's file operands (for `cat`, `ls`, `grep`, `find`, `cp`, `mv`, `rm`, `touch`, `tee`, `sed` and the rest of the list) and its redirections are compared with the working directory and the added directories. A write whose target is a variable is asked about as spelled; a relative write after a literal `cd <folder>` inside the working directory (`cd packages/sdk && echo x > out.txt`) is placed in that folder and is not asked about. Only the read commands' variable paths and anything outside that list are left alone; [Crossing the tool boundary](../sdk/escalations.md) has the list.
- **Protected files are asked about in every mode.** A write to `.git`, `.vscode`, `.idea`, `.husky`, `.cargo`, `.devcontainer`, `.yarn`, `.mvn`, `.config/git`, `.namzu`, a shell startup file (`.bashrc`, `.zshrc`, `.profile`, …), `.gitconfig`, `.envrc`, `.npmrc`, `namzu.config.json`, the project's curated memory `.namzu/MEMORY.md` and the other configuration files the list names is shown with `Writes a protected file or folder: <path>`, offers only Yes and No, and is asked even where a rule allows the tool. `bypass` runs it without asking; `auto` sends it to the classifier. Nobody to ask (a headless `namzu exec`, a scheduled run) means refused. `write`, `edit`, redirections and `cp`, `mv`, `touch`, `mkdir`, `rm`, `rmdir`, `tee` and `sed -i` are covered.
- **A removal that could take the home folder is asked about in every mode, `bypass` and `auto` included.** `rm` and `rmdir` are read by their targets, whatever the order of the flags (`rm -fr /`, `rm -r -f ~`, `rm --recursive --force /`): the root, a top-level folder, `~` and `$HOME`, `..`, the working folder or a parent of it, a glob across folders, and `"$DIR/"` where an empty variable leaves `/` are asked about, with nobody to ask refused. `rm -rf /…` is still denied outright where the dangerous-command floor is on.
- `/add-dir <path>` adds a directory for the rest of the session so the tools reach it without asking. For a directory outside the working directory it **asks you first**, decided after links are followed: `./link` pointing outside is asked about under the path it leads to, and that canonical path is what is added, so retargeting the link later reaches nothing new. A directory inside the working directory is not added: the tools already reach it.

The startup notice says `Sandbox off (the default)` and names the key that turns it on.

## Opting in: `sandbox.enabled: true`

```json
{ "sandbox": { "enabled": true } }
```

With the sandbox on, each command runs confined to the working directory and the added directories (read-write), with the network cut where the platform can cut it (on Linux, `bwrap --unshare-all`). Under `bwrap` the command also sees the system directories and the Node runtime read-only, `/proc`, `/dev` and a private `/tmp`; a tier that cannot confine the file system (`linux-namespace`, `basic`) says so at startup and in the model's prompt. What the machine enforces is reported at startup, and `sandbox.requireIsolation` refuses to start when a named control cannot be enforced. The sandbox is the same strength it was: file tools resolve inside it, and a path it does not mount is refused.

`sandbox.enabled` is on without being written when `sandbox.requireIsolation` names a control or `sandbox.workspace` is `ephemeral`, because both only mean something inside a sandbox. `sandbox.enabled: false` turns it off even then.

### Leaving the sandbox for one command

A sandboxed `bash` call can set `dangerously_disable_sandbox: true` to run that one command on the host (it needs the network, a path the sandbox does not mount, or a host tool). The request is:

- **asked about every time**, in every permission mode that does not refuse it — `bypass`, `auto`, `--yolo` and a remembered "don't ask again" included. The prompt says `Runs OUTSIDE the sandbox, on this machine`, and offers only Yes and No. An answer given on one prompt never settles a queued escape that was not on screen.
- **refused in a turn with nobody to ask** (a headless `namzu exec`, a drained turn) unless `sandbox.allowUnattendedEscape: true`.
- **refused in `plan` and `strict` mode**, like any other change.
- **recorded** in the audit trail as a `sandbox_escape` record, `approved` or `refused` — a refusal by the person, by a `deny` rule, by the headless default, or by a policy that did not confirm it.
- **never combined with `run_in_background`**: a host job would outlive the approval given for one call.

| Key | Default | Meaning |
| --- | --- | --- |
| `sandbox.enabled` | `false` (see above) | Confine commands in the OS sandbox. |
| `sandbox.allowEscape` | `true` | Allow a sandboxed `bash` call to ask to leave the sandbox. `false` refuses every such request. |
| `sandbox.allowUnattendedEscape` | `false` | Grant that request without a prompt when nobody can be asked. |

## The browser

The [browser tools](browser.md) drive a real browser, which runs outside the sandbox whether it is on or off: in WSL, it is the Windows Chrome. What they may open and change is `browser.sites`, compiled to rules the gate applies before the call and checked again by the browser host after every navigation. Only the interactive terminal mounts them.

## What the model is told

On the host, the environment block also says what the turn's permission mode does to a call, per mode and no more than the mode does: `prompt` puts calls the rules do not allow to the user, `accept-edits` runs file edits and simple file commands in the working directory without asking, `plan` refuses every change, `bypass` runs calls without asking but keeps what always needs the user and the safety rules, `auto` has a second model block the risky calls, `strict` runs only preapproved tools, and an unattended run asks nobody. A session with nobody at the terminal is told a call that would ask is refused. A mode change re-keys the cached prefix once, as plan mode already did. A sandboxed session keeps the sentence the backend produces.

The environment block in the system prompt states the boundary, so the model does not have to infer it from refusals: whether tools run on the host or in a sandbox (and what the sandbox enforces), that a path outside the working directory is asked about rather than refused (or, with nobody to ask, refused and named so `--add-dir` can add it), what a sandbox that confines the file system still shows a command, `/add-dir` for a directory it needs repeatedly, and — only in a sandboxed session that allows it — the per-command escape. A refusal a file tool still returns names the way to widen the boundary instead of ending at "may only reach".

The identity block that opens the system prompt names the tools it mentions (`bash`, `Agent`) from the tools' own names rather than typing them, so a rename cannot leave a sentence pointing at a tool that does not exist, and it no longer carries a closed list of six tools: it asks the model to prefer the dedicated file tools over a shell equivalent and to use `bash` for the rest. It says one thing about parallel work: independent tool calls may share a response, `bash` calls run one at a time in order, and the model must not claim two ran in parallel without timestamped proof; the foreground `bash` tool's description says the same and does not send shell work through a sub-agent. A test assembles the main, plan-mode and sub-agent prompts and fails on a backticked tool name that is not a mountable tool, on another product's name, and on wording that tells the person to start over (`packages/cli/src/context/__tests__/prompt-lint.test.ts`).

One function, `composeSessionSystemPrompt` (`packages/cli/src/context/system-prompt.ts`), assembles the session's system prompt, and a new turn and a resumed delegated turn both call it, so a resumed turn gets the same sections a new one does: the workflow rule is the only one it lacks, because a resumed turn is not offered the workflow tool. Plan-mode doctrine, deferred-tool guidance, the conversation-evidence section, the operator's active skills, the status note and the environment follow the resumed turn's own mode and toolset; the Agent-tool advice is left out when the session withholds that tool. A resident step gets the identity and little else (its context carries the working policy), and a sub-agent keeps its own role prompt plus the working doctrine. The file's header table records which audience gets which section.

## WSL

On Windows Subsystem for Linux (detected from `WSL_DISTRO_NAME` or `WSL_INTEROP`) the model is also told:

- the Windows drives mounted under `/mnt/<letter>` (`C:\Users` is `/mnt/c/Users`; `wslpath` converts), or under the root `[automount] root` in `/etc/wsl.conf` names, which the note's paths then use, and that a file tool reaching them asks first like any other outside path;
- that Windows programs start from the shell through WSL interop by their `.exe` name — `powershell.exe -NoProfile -Command ...`, `cmd.exe /c ...` — that `explorer.exe` exits 1 even when it succeeds, and that `cmd.exe` started from a Linux directory warns about UNC paths and falls back to `C:\Windows`;
- when interop is off (no `WSL_INTEROP` and no `/proc/sys/fs/binfmt_misc/WSLInterop`), that `.exe` programs cannot be started;
- in a sandboxed session, that the drives and the programs on them are not mounted, so they need `/add-dir` or the escape.

## Upgrading from the sandboxed default

The previous CLI turned the sandbox on unless `sandbox.enabled: false` was written. To keep that behaviour, write `sandbox.enabled: true` in `namzu.config.json` or `~/.namzu/config.yaml`. A config that already had `sandbox.enabled: false` behaves as before, except that a path outside the working directory is now asked about instead of refused when someone is at the terminal (a headless turn still refuses it).
