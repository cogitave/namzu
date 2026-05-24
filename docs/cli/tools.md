---
title: Tools & permission
description: The builtin tools, the optional clawtool bridge, and the interactive approve/reject/approve-all permission prompt.
last_updated: 2026-05-25
status: current
related_packages: ["@namzu/cli", "@namzu/sdk"]
---

# Tools & permission

namzu drives the full `@namzu/sdk` agent loop, so the model can call tools: read files, run shell commands, edit code, search, and more. Tool results feed back into the loop until the turn settles.

## Builtin tools

Every session registers the SDK builtins, which run natively in-process:

| Tool | Purpose |
| --- | --- |
| `bash` | Run a shell command. |
| `read` | Read a file (line-range aware). |
| `write` | Write a file. |
| `edit` | Replace text in a file. |
| `append` | Append to a file. |
| `glob` | Match files by pattern. |
| `grep` | Search file contents. |
| `verify_outputs` | Validate produced outputs. |

## The clawtool bridge

If a local clawtool daemon is reachable, namzu folds its MCP tool catalog into the agent alongside the builtins. A warm daemon contributes its full catalog minus the handful that duplicate builtins (Bash/Read/Edit/Glob/Grep/Write). Bridged tools are namespaced `clawtool_<Name>` — e.g. `clawtool_WebSearch`, `clawtool_BrowserFetch`, `clawtool_SandboxRun`, `clawtool_Commit`, `clawtool_Spawn`.

This is best-effort: if clawtool is absent, down, or slow to respond, namzu silently runs on builtins alone — startup never fails because of it. The connect line and `/tools` show the total tool count.

## The permission prompt

Mutating actions ask before they run. Before a tool batch executes, namzu decides:

- **Read-only batches** (only `read`/`glob`/`grep`/`ls`/`verify_outputs`) run silently.
- **Anything else** — writes, `edit`, `bash`, anything the SDK flags destructive, and any tool not on the read-only allowlist (including bridged clawtool tools) — shows a prompt.

The prompt lists each proposed call with a one-line summary, plus a preview for the riskiest ones: the content for `write`, and a `- old` / `+ new` diff for `edit`. Respond with:

| Key | Decision |
| --- | --- |
| `y` (or `Enter`) | Approve this batch. |
| `n` (or `Esc`) | Reject — the model is told you declined and can adapt. |
| `a` | Approve this and everything else for the rest of the session. |

`Ctrl+C` at the prompt rejects and aborts the turn.

> The permission prompt is interactive only in the TUI. Programmatic/embedded use of the session auto-approves unless a permission handler is supplied.
