---
type: Guide
title: Session loops
description: "`/loop` and the session_loop tool: re-sending a prompt to the open conversation on an interval, between turns — timing, limits, persistence across /resume, and the model's version."
resource: packages/cli/src/tui/schedule/loop-host.ts
tags: [cli, tui, schedule, loops]
status: stable
generated: { by: process:claude-code, at: 2026-09-23T00:00:00Z }
---

# Session loops

A loop re-sends a prompt to **this** conversation on an interval while the TUI
is open — "check the build every ten minutes", "summarise new mail every hour".
It is not a [scheduled job](scheduled-tasks.md): it runs only while the session
is open, in the session's own folder, under your current permission mode,
because you are there.

```text
/loop 10m check the CI status and tell me if anything turned red
/loop 0 9 * * 1-5 /standup
/loop list
/loop stop 3fa2c1
/loop stop all
```

The interval is `5m`, `2h`, `1d`, or a five-field cron expression in this
machine's time zone. In a loop you made, a prompt starting with `/` runs that
command, and `!` and `#` mean what they mean when you type them
([composer prefixes](composer-prefixes.md)). A loop the model made never does
any of that; see [The model's version](#the-models-version). A loop's prompt
is not added to the composer's history: Up brings back what you typed.

## When it fires

- Only between turns. The prompt arrives as the next turn, preceded by a line
  `↻ loop <id>`.
- A loop that comes due while a turn runs fires **once** when the session is
  idle again — never once per interval it missed. The session is yours, and a
  queue of catch-up prompts would take it over.
- One loop fires at a time; another that is due waits for the next idle moment.

## Limits

- At most 20 loops per conversation.
- At least a minute apart (`30s` is refused and names `1m`).
- Each loop expires seven days after it was made.

## Across `/resume`

Loops live in `<session-id>/loops.json` beside the session log and come back
when you `/resume` the conversation, except those that expired. They stop when
the TUI exits; nothing runs them while it is closed — that is what scheduled
jobs are for.

## The model's version

The `session_loop` tool (`create`, `list`, `delete`) lets the model set up a
loop when you ask for one. Creating a loop is an ordinary reviewed call: it is
not exempt from review, so in `prompt` mode you see it before it exists. A loop
the model made is shown as `(created by the model)` in `/loop list` and on each
`↻` line. `list` and `delete` only read or remove loops.

Every time a loop the model made fires, its prompt is sent to the model as
plain text, whatever it starts with. `/permissions auto` is a sentence the
model reads, not a command; `!rm -rf build` is not run on the host; `#note` is
not remembered; and "switch to another model" does not switch it. Only you
can do those things, by typing them. Before this, a model's loop could run
`!` commands on the host, outside the sandbox and with no review, on every
fire for up to seven days after one review of its creation — and in `auto`
mode, with none.
