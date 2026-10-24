---
type: Reference
title: Custom status line
description: The statusLine config key, a command whose output the interactive terminal draws above the footer — the JSON it reads on stdin, when it runs, how its output is shown, where it may be set and what happens when it fails.
resource: packages/cli/src/tui/status-line/payload.ts
tags: [cli, tui, footer, config, status-line]
status: stable
generated: { by: process:claude-code, at: 2026-10-19T00:00:00Z }
---

# Custom status line

`statusLine` names a command. The interactive terminal runs it, hands it a
JSON object describing the session on stdin, and draws what it prints, dimmed,
on the rows directly above the footer line. The key, the field names and the
rules for when it runs are fixed, so a script that reads these fields works
here unchanged where the field exists.

```yaml
# ~/.namzu/config.yaml
statusLine:
  command: ~/.namzu/statusline.sh
  padding: 1          # optional: columns of space on each side, default 0
  refreshInterval: 30 # optional: also run every N seconds, at least 1
```

`type: command` is accepted (it is the only kind) so a block copied from a
Claude Code settings file loads. Any other key, or a command that is empty, refuses
the config at load and names the setting.

## Where it may be set

The user file and the project's `namzu.config.json`, like `hooks`. It is never
read from the environment. A project file is read only after the folder is
trusted, so an untrusted folder's command never starts: the trust screen draws
no status line and nothing runs before you answer. The managed file may set it
and wins over both.

## What the command receives

One JSON object on stdin, the shell's working directory is the session's, and
`COLUMNS` is the terminal width. Fields, by name:

| Field | Value |
|---|---|
| `hook_event_name` | `"StatusLine"` |
| `session_id` | the conversation id |
| `cwd`, `permission_mode` | the working directory; `prompt`, `accept-edits`, `plan`, `bypass`, `auto` (the classifier mode) or `strict`, in the words `--permission-mode` takes |
| `model` | `{ id, display_name }`, both the model name the footer shows |
| `workspace` | `{ current_dir, project_dir, added_dirs, git_worktree?, repo? }`; `repo` is `{ host, owner, name }` from `origin` |
| `version` | the CLI version |
| `cost` | `{ total_cost_usd, total_duration_ms }` for this session |
| `context_window` | `{ total_input_tokens, context_window_size, used_percentage, remaining_percentage }`, once a turn has reported its context |
| `exceeds_200k_tokens` | whether the context is past 200,000 tokens, with `context_window` |
| `effort` | `{ level }` when an effort is set |
| `agent` | `{ name }` in a Pal conversation |
| `pr` | `{ number, url, review_state? }` for an open pull request; `review_state` is `approved`, `pending`, `changes_requested` or `draft`, and is absent once merged |

A field appears only when the terminal has the fact; read every optional field
as possibly missing. These fields are **not** sent, because Namzu
has no data for them: `session_name` (not sent yet), `output_style`, `fast_mode`, `thinking`, `vim`,
`rate_limits`, `prompt_cache`, `remote`, `worktree`, `transcript_path`,
`cost.total_api_duration_ms`, the line counters under `cost`, and
`context_window.total_output_tokens` and `current_usage`.

```bash
#!/bin/sh
input=$(cat)
model=$(echo "$input" | jq -r '.model.display_name')
used=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
printf '%s | %s%% | %s\n' "$model" "${used:-0}" "$(basename "$(echo "$input" | jq -r .cwd)")"
```

## When it runs

- Once when the screen opens, and at once when the command changes.
- 300 ms after any of these change: the context size, the permission mode,
  the model, the effort, the pull request, or a finished message. A burst of
  changes is one run.
- Every `refreshInterval` seconds when set, through the same 300 ms delay.
- A new run stops the one still going, and a stopped run's output is never
  shown. A run that outlives ten minutes is stopped.

## How the output is shown

Every non-blank line, trimmed, becomes one dim row cut at the terminal's edge.
Colours (`ESC [ … m`) and OSC 8 links are kept and carried onto the following
lines; every other escape sequence and control character is removed, so a
script cannot move the cursor over the composer. A script that resets its
colours also resets the dimming. With a status line configured the quiet
`shift+tab to cycle` reminder is not drawn; the mode, pills and model on the
footer line stay.

An exit code other than `0`, empty output, a command that cannot start, a
timeout or a stopped run all draw nothing: a stale line is worse than none.
stderr is discarded.

Only the interactive terminal runs it; `exec`, `drain`, ACP and scheduled
runs do not.

See [Terminal design](terminal-design.md#the-composer-footer) for the footer
line it sits above.
