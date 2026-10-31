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

`namzu spaces` opens one terminal with a sidebar on the left and the selected session on the right.
The sidebar lists your **spaces** on top, which are project folders, each with one dot for the most urgent thing in it. Below them it lists the **sessions** of the selected space, each with its own dot.
Each session is a whole Namzu running in its own terminal, so a session that stops does not take the others down.
This is a preview, and the plain `namzu` command is unchanged.

Options after `spaces` go to the first session, so `namzu spaces --model <name>` starts it on that model.
Sessions you add later start with the default options.
Every session starts in its space's folder and inherits the environment the command started with.

## The dots

| Dot | Meaning |
| --- | --- |
| red | A session needs your approval before it can go on. |
| blue | A session finished a turn while you were looking at another one, and you have not looked since. |
| yellow | A session is working. |
| green (hollow) | A session is idle. |
| grey | A session is starting, has not been opened yet, or has ended. |

A space shows the most urgent of its sessions' dots, in the order above. Under a row, plain words say the same ("needs approval", "finished", "working"), and a session on a non-default account shows that account's label on its row.
Looking at a session, by selecting it, clears its blue mark.

The dots come from what each session reports about itself, not from reading its screen: every session publishes a live record and answers a ping, and the host reads the records as they change and asks each session directly every few seconds, so a change that was never written is still caught. A turn that begins and ends between two reads can still be missed when the file watcher is unavailable; the host then re-reads once a second.

## Keys

Everything you type goes to the session except the navigate key, `ctrl+b` by default.

| Key | What it does |
| --- | --- |
| `ctrl+b` | Enter navigate mode. |
| `ctrl+b` `ctrl+b` | Send one `ctrl+b` to the session. The composer uses it to move the cursor left. |
| `j`, `k`, arrows | Move between the sessions of the selected space. |
| `J`, `K` | Move between spaces. |
| `1` to `9` | Pick a space by number. |
| `n` | New session in the selected space. |
| `N` | New space from a folder you type. A folder that is already a space is only shown. |
| `r`, `R` | Rename the session, or the space. |
| `d`, `D` | Close the session, or the space with all its sessions. It asks first. Closing the last session quits. |
| `enter`, `l` | Back to the session. A session that has not been opened yet starts now. |
| `b` | Hide or show the sidebar. |
| `q` | Quit. It asks first while a session is running. |
| `esc` | Leave navigate mode. |

Pasted text is never read as the navigate key.

## Mouse

Click a space or a session to open it, scroll over the sidebar to move its lists, and scroll over a session to read its history; a line at the bottom says you are scrolled back, and typing or scrolling down returns you to the live screen. The host takes the mouse, so selecting text with the pointer needs the terminal's own override, usually holding `shift`.

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

The spaces and sessions are not saved: quitting ends them, and the next `namzu spaces` starts with one session in the current folder. A session is not started until it is opened, but nothing lists unopened sessions until saving exists. There is no keyboard enhancement protocol inside a session (shifted Enter and similar keys arrive as the plain key). The terminal title and hyperlinks a session sets are not forwarded, and a session that asks for mouse reports does not receive them.
