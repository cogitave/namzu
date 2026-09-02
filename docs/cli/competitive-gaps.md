---
type: Analysis
title: Where the CLI stands against its peers
description: What `Claude Code`, `Codex CLI`, `Gemini CLI` and `OpenCode` offer that namzu does not, what namzu does better, and the backlog that follows, ordered by what an operator feels first.
tags: [cli, sdk, product, backlog]
status: draft
generated: { by: human:bahadirarda, at: 2026-09-02T00:00:00Z }
sources:
  - id: cc-ref
    resource: https://hidekazu-konishi.com/entry/claude_code_features_settings_reference_2026.html
    title: `Claude Code` features and settings reference 2026
  - id: peer-c-guide
    resource: https://blakecrosley.com/guides/codex
    title: `Codex CLI` guide 2026
  - id: peer-g-docs
    resource: https://geminicli.com/docs/
    title: `Gemini CLI` documentation
  - id: opencode
    resource: https://openagent.bot/agents/opencode/
    title: `OpenCode` feature overview
---

# Where the CLI stands against its peers

Surveyed on 2026-09-02 against the published feature sets of `Claude Code`,[^cc-ref] `Codex CLI`,[^peer-c-guide] `Gemini CLI`[^peer-g-docs] and `OpenCode`.[^opencode] Only what an operator can see or a host can call counts; marketing does not.

# What namzu has that they do not

- **A scored working set with no model in the loop.** Every message scored by recency, relevance, use and repetition; the context held from half the window; verified summaries optional. The peers compact at a threshold with a model.
- **An exact-input consent envelope.** The review dialog is derived from an immutable JSON envelope of the prepared calls, one key from the readable view; nothing a formatter shows can differ from what runs.
- **A sandbox on by default** where the host has one (`bwrap`), with an authorization gate that reads a tool's own declarations rather than a name list.
- **A kernel with evals, telemetry, A2A and ACP bridges, provider-chain failover, guarded web fetch, plugin lifecycle with authority gates, a task store and session goals** — the CLI is one host of it, not the product.
- **Consolidation**: a run's decisions, discoveries and failures written to the memory store as a learning.

# What they have that namzu does not

| Gap | Who has it | Cost to close | Status |
| --- | --- | --- | --- |
| Background jobs that survive a turn and *notify* the model when they finish | `Claude Code` (`run_in_background` + completion notices), `Gemini` | kernel: owner lifetime, exit subscription, event + notice; CLI: registry per session, `/jobs`, transcript row | done |
| Background jobs inside the sandbox | `Claude Code` | a sandbox execution seam for persistent processes; no built-in backend has one | done — `Sandbox.spawnDetached`, implemented by the local provider |
| `!command` — run a shell command from the composer without the model | `Claude Code` | composer prefix, transcript row, no model call | done |
| `#note` — add to memory from the composer | `Claude Code` | composer prefix over `save_memory` | done |
| `Esc Esc` — pop back to an earlier turn | `Claude Code` | key binding over the existing edit-previous picker | already there: a second empty Esc opens the prompt picker; picking forks before that prompt and reopens it |
| Hook events beyond four | `Claude Code` (10), `Gemini` | `user_prompt_submit`, `pre_compact`/`post_compact`, `session_start`/`session_end`, `subagent_stop`; the kernel already fires `iteration_*`, `pre/post_llm_call`, `run_interrupt` | done — fourteen events, ten reachable from a shell |
| `/add-dir` — more than one directory in a session | `Claude Code`, `Gemini` | sandbox mounts and authorization scope for a second root | done — tools, sandbox binds and the environment prompt; `--add-dir` and the config key too |
| `/hooks`, `/agents`, `/config`, `/release-notes` | `Claude Code` | listing commands over state the session already has | `/hooks` and `/release-notes` done; `/agents` was already the kernel's; `/status` already answers what `/config` would |
| Output styles | `Claude Code` | a prompt contribution per style | backlog, low |
| File checkpoints and rollback of edits | `Gemini` | snapshot before a write, `/restore` | done — tool writes only; shell and sub-agent writes are not covered |
| Session share links, desktop app | `OpenCode` | out of scope for a terminal-first kernel | no |
| Vim keybindings | `Claude Code`, `Codex` | a composer mode | backlog, low |

# Order

1. Background jobs done right — the one gap that changes what a long task can be. Done, outside the sandbox.
2. `!` and `#` in the composer — the two daily conveniences. Done.
3. Hook events to parity. Done.
4. `Esc Esc`, `/hooks`, `/agents`, `/release-notes`. Done.
5. `/add-dir` and file checkpoints, each its own design. Done.
6. Background jobs inside the sandbox — the seam the first item left open. Done.
7. Output styles and vim keys, when someone asks.

[^cc-ref]: `Claude Code` features and settings reference 2026
[^peer-c-guide]: `Codex CLI` guide 2026
[^peer-g-docs]: `Gemini CLI` documentation
[^opencode]: `OpenCode` feature overview
