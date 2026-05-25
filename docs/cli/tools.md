---
title: Tools & permission
description: Builtin tools, agent memory + task tools, the deferred clawtool bridge, the permission prompt, the safety gate, and bypass mode.
last_updated: 2026-05-25
status: current
related_packages: ["@namzu/cli", "@namzu/sdk"]
---

# Tools & permission

namzu drives the full `@namzu/sdk` agent loop, so the model can call tools: read files, run shell commands, edit code, search, track a plan, and remember things. Tool results feed back into the loop until the turn settles.

## Builtin tools

Every session registers a lean, native tool set:

| Tool | Purpose |
| --- | --- |
| `bash` | Run a shell command. |
| `read` | Read a file (line-range aware). |
| `write` | Write a file. |
| `edit` | Replace text in a file. |
| `glob` | Match files by pattern. |
| `grep` | Search file contents. |
| `search_memory` / `read_memory` / `save_memory` | The agent's structured memory ([Memory](./memory.md)). |
| `task_create` / `task_update` / `task_list` | Track a plan for the current request (see below). |
| `search_tools` | Load deferred clawtool tools on demand (see below). |

## Plan / task tracking

The agent can lay out a multi-step plan with the task tools. New tasks appear in the transcript as `☐ <subject>` and completed ones as `☑ <subject>`, so you can watch it work through a todo list for the current request.

## The clawtool bridge (deferred)

If a local clawtool daemon is reachable, namzu makes its ~70-tool catalog available — but **deferred**: the tools are listed by name only (no schema bloat in the prompt), and the agent loads the ones it needs via `search_tools`. This keeps per-message token cost low while still giving access to `clawtool_WebSearch`, `clawtool_BrowserFetch`, `clawtool_SandboxRun`, `clawtool_Commit`, `clawtool_Spawn`, and more. Best-effort: if clawtool is absent/down, namzu runs on builtins alone. The connect line shows `N tools (+M on demand)`.

## The permission prompt

Mutating actions ask before they run:

- **Read-only / agent-state tools** (`read`/`glob`/`grep`, the memory + task tools) run silently.
- **Anything else** — `write`, `edit`, `bash`, and any tool not on the safe allowlist (including bridged clawtool tools) — shows a prompt with each proposed call, plus a preview for the riskiest: the content for `write`, a `- old` / `+ new` diff for `edit`.

| Key | Decision |
| --- | --- |
| `y` (or `Enter`) | Approve this batch. |
| `n` (or `Esc`) | Reject — the model is told you declined and can adapt. |
| `a` | Approve this and everything else for the rest of the session. |

`Ctrl+C` at the prompt rejects and aborts the turn.

## The safety gate

Independent of the prompt, a verification gate hard-denies a narrow set of catastrophic shell patterns **before they ever run** — `rm -rf /`, `mkfs`, `dd if=`, fork bombs, `sudo` / `su -`, `chmod 777 /`, `curl|sh` / `wget|sh`, `ssh user@host`, and dynamic `eval`. This applies even in bypass mode, so namzu can't be made to brick the machine. The list is deliberately narrow — everyday commands like `rm -rf node_modules` are unaffected.

## Bypass mode

Launch with `namzu --dangerously-skip-permissions` (alias `--yolo`) to run tools without the approval prompt — useful in a sandbox or a folder you fully trust. A red banner warns while it's active, and the safety gate above still applies.

> The permission prompt is interactive only in the TUI. Programmatic/embedded use of the session auto-approves unless a permission handler is supplied.
