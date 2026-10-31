---
type: Reference
title: namzu spaces (preview)
description: A sidebar of sessions beside a live Namzu session in one terminal, its keys, the prefix setting, what happens when a session stops, and what the preview does not do yet.
resource: packages/cli/src/commands/spaces.ts
tags: [cli, spaces, terminal, preview]
status: draft
generated:
  by: claude/sonnet-5.5
  at: 2026-10-31
---

# namzu spaces (preview)

`namzu spaces` opens one terminal with a sidebar of sessions on the left and the selected session on the right.
Each session is a whole Namzu running in its own terminal, so a session that stops does not take the others down.
This is a preview: it shows a single session so far, and the plain `namzu` command is unchanged.

Options after `spaces` go to the session, so `namzu spaces --model <name>` starts it on that model.
The session starts in the folder you ran the command from and inherits the environment the command started with.

## Keys

Everything you type goes to the session except the navigate key, `ctrl+b` by default.

| Key | What it does |
| --- | --- |
| `ctrl+b` | Enter navigate mode. |
| `ctrl+b` `ctrl+b` | Send one `ctrl+b` to the session. The composer uses it to move the cursor left. |
| `j`, `k`, arrows | Move between sessions. |
| `enter`, `l` | Go back to the session. |
| `1` to `9` | Pick a session by number. |
| `b` | Hide or show the sidebar. |
| `q` | Quit. It asks first while a session is running. |
| `esc` | Leave navigate mode. |

Pasted text is never read as the navigate key.

## Changing the navigate key

```yaml
tui:
  spacesPrefix: ctrl+a
```

The value is `ctrl+` and a letter, or `ctrl+space`. `ctrl+c`, `ctrl+d` and `ctrl+z` are refused because the session needs them, as are the keys that are Tab, Enter, Backspace and Escape. A refused value names `tui.spacesPrefix` in the error.

## When a session stops

Its sidebar row turns grey and says "ended" or "stopped", and a line at the bottom of the session area says so in plain words. The conversation is saved. The other sessions keep running, and `ctrl+b` then `q` leaves.

## When there is no terminal component

Spaces needs a pseudo-terminal binding. The CLI ships the prebuilt `@lydell/node-pty` first and falls back to `node-pty`, so a Linux machine without a compiler normally has one. If neither loads, `namzu spaces` prints one line saying why and runs a single plain session instead. It needs an interactive terminal and exits with an error otherwise.

## What it does not do yet

One session, no mouse, no status dots beyond running and ended, no saved layout, and no keyboard enhancement protocol inside the session (shifted Enter and similar keys arrive as the plain key). The terminal title and hyperlinks a session sets are not forwarded.
