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
is not added to the composer's history: Up brings back what you typed. No
loop's prompt ever carries a [composer trigger](composer-triggers.md): only
keys typed in the composer arm one.

A loop without an interval is self-paced:

```text
/loop watch the deploy and tell me when it is healthy
```

The first tick runs as soon as the conversation is idle (a few seconds at most). If you mistype an interval (`/loop 10 minutes ...`), Namzu says so instead of starting a loop. `wake_up` with stop ends only a loop that is waiting for its wake-up, never one between ticks. Each tick the model does the
task, then says when to wake next (a minute to an hour away, whatever it asked
is held to that range), why, and whether anything changed. A tick that ends
without naming a next wake-up ends the loop, and so does the model saying it is
finished. When it wakes again is printed (`↻ Loop 3fa2c1 wakes again at 14:30
(in 20 min): watching the deploy`) and `/loop list` shows the next wake-up and
its reason. A run of quiet ticks (nothing changed) prints one line, then nothing
until a tick finds something. The same seven-day limit applies.

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
jobs are for. A scheduled job can send a host-owned result notice back to the
conversation that proposed it, but that does not run the job as a turn in this
conversation and does not add a model message to it.

## Timers the model sets

For a reminder or a short check the model sets itself, it has `timer_set`,
`timer_list` and `timer_cancel`, found through `search_tools` like other
deferred tools. A timer fires a prompt into this conversation once (`recurring:
false`, or an `in 10m` / `at 14:30` time) or on an interval or cron schedule.

- No review is asked: a timer exists only in memory, never in the schedule
  store, and is gone when the session closes or you switch conversations.
- It fires only between turns. One that comes due during a turn waits and fires
  once when the turn is over; one timer fires per idle moment.
- You see what fired: `⏰ timer 3fa2c1 (set by the model, every 10 minutes): <prompt>`.
  The prompt is plain text to the model, never a command.
- At most 50 timers. A recurring timer ends after seven days.
- A recurring timer may run late by up to half its interval and never more than
  30 minutes; a one-time timer set for :00 or :30 may run up to 90 seconds early.
  This spreads timers set for the same minute apart.

`/loop list` is only for loops. You see pending timers in the `Timers` section of
the `/tasks` dialog (the prompt and the time left; `x` cancels the selected one,
the same cancel as `timer_cancel`; Enter opens the whole prompt, which a long row cuts short; a timer set while the dialog is open appears within a second) and in `/tasks list`; the model lists them
with `timer_list`.
For work that must run while Namzu is closed use a
[scheduled task](scheduled-tasks.md).

## The model's version

The `session_loop` tool (`create`, `list`, `delete`) lets the model set up a
loop when you ask for one (leave out the interval for a self-paced one, which the model paces with `wake_up`). Creating a loop is an ordinary reviewed call: it is
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
