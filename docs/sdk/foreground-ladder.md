---
type: Reference
title: The foreground ladder
description: How computer use takes the user's screen when background delivery is impossible — the idle gate, the screen lease, the watched burst, the conditional restore, the one question to the user, the Escape stop and the security refusals, with every threshold and bound.
resource: packages/computer-use/src/foreground
tags: [computer-use, windows, foreground, safety]
generated: { by: human:bahadirarda, at: 2026-11-01T00:00:00Z }
---

# The foreground ladder

Computer use works in the background first: it reads a window's controls and
acts on them without moving the user's pointer or changing their foreground
window. Some input cannot be delivered that way (a web page's keyboard input,
a window the driver reports as covered, a window that needs real focus). On
Windows (WSL included) `@namzu/computer-use` then retries the same action in the
foreground, but only through the ladder below. The model never sees a silent
escalation: the result says the screen was used, for how long, and whether the
previous window and pointer were put back.

What goes through the ladder:

- a window action the driver refuses with `background_unavailable` or
  `background_occluded` (`background_uipi_blocked` does not: administrator-rights
  windows block foreground input too, and the result says to ask the user);
- any action the model sent with `delivery_mode: "foreground"`;
- display-scope input (`mouse_move`, `mouse_click`, `mouse_drag`, `scroll`,
  `type_text`, `key`) and `focus_window`, on both the cua-driver backend and the
  PowerShell fallback backend;
- a control click (`ui_act` invoke, expand, collapse, toggle, select) that the
  driver refuses in the background.

Reads (`screenshot`, `cursor_position`, `list_windows`, `ui_snapshot`) never do.

## The steps, in order

| Step | Rule | Value |
|---|---|---|
| Stop | After a physical Escape, every computer-use call of the turn fails with one fixed message | until the next turn |
| Lease | One session at a time holds `<NAMZU_HOME>/computer-use/screen.lease`; waits for another | 30 s, polled every 200 ms |
| Safety | Refuses a lock screen, an administrator-permission prompt, another input desktop, and a target running with higher rights | no wait |
| Idle gate | The user has had no real input for | 2 s, polled every 50 ms |
| Busy user | Keeps waiting, then asks once | after 15 s |
| After a yes | Needs a shorter pause; waits at most | 0.5 s, 30 s |
| Nobody to ask (exec, scheduled) | Parks and polls, then returns `user_active` | 120 s, every 250 ms |
| Burst | Watched from start to end for real input | 50 ms |
| Restore | The window is put back only if this burst raised a window and that window (or another of its program) is still in front, even when the user typed meanwhile; a burst that raised nothing restores no window, so a click that opened another window is not undone. The pointer is put back only if nobody touched input | after the burst |
| Idle check before the raise | The helper checks the user has been still before it raises anything; if not, nothing moves and the ladder starts the burst again | at `begin` |
| Parked time per turn | All parked calls of one turn together | 600 s |

The 2 s threshold was measured on the development machine: in 180 s with nobody
at it, the idle clock was at 2 s or more for 92% of the time (5 s: 81%, 10 s:
61%), because a keep-awake tool nudges the pointer every 26 s. A longer gate
would starve the ladder there for no gain. It is a starting value; every number
above is `DEFAULT_TIMING` and can be overridden through
`SubprocessComputerUseHost`'s `foreground.timing`.

## Watching the user

A long-lived helper (one PowerShell process, started from an encoded command so
no file is read over the WSL network share) installs low-level keyboard and
mouse hooks. Input the machine injected carries a flag and is not counted, so
the burst's own input and a keep-awake nudge are never mistaken for the user;
the system idle clock (which cannot tell them apart) is used only to make the
gate more careful, and it ignores the span of the ladder's own bursts. A poll
answers in about 0.5 ms; starting the helper takes about 0.8 s warm. If the
hooks cannot be installed the burst is refused (`monitor_unavailable`): the
ladder never runs unwatched.

The helper is also the watchdog. If the program that started it dies, its input
closes; the helper then puts back what a burst in progress moved and deletes the
lease file, whatever the lease says.

## Interference and the result

If the user touches input between the last look and the start, the burst does
not start and the gate runs again (at most three times). If they touch it during
the burst, the result is `delivered_unverified` and `retrySafety: unsafe` with a
note to look before repeating: a burst is one driver call, so it cannot be
unsent. A multi-step burst checks before each step and stops without sending the
next one. Nothing in a blocked result was sent:

| Code | Meaning | What the model is told |
|---|---|---|
| `user_active` | Still busy after the wait (or after agreeing) | Do other work, try again later |
| `lease_busy` | Another session holds the screen | Try again in a moment |
| `declined` | The user said no | Do not ask again this turn |
| `stopped` | Escape was pressed | Stop; tell the user what is left undone |
| `monitor_unavailable` | Real input cannot be observed | Use controls by ref or ask the user |
| `locked_desktop` | LockApp, LogonUI or winlogon in front | Ask the user to unlock; never work around it |
| `uac_prompt` | consent.exe in front | Ask the user to answer it |
| `secure_desktop` | The input desktop is not `Default` | Ask the user to answer it |
| `elevated_target` | The target has higher rights than this process | Ask the user; never work around it |

All of them are `not_delivered` with `retrySafety: safe`.

## The question

When the user stays busy for 15 s the ladder asks once, through the turn's
question card: "Let *app* use the screen for a moment?", "Yes, this session" or
"Not now". The subject is the application (display name and executable), not the
screen. A yes is remembered for the session; a no is remembered for the turn. A
turn with nobody to answer gets `unavailable` and parks instead. Text inside the
target application never answers the question.

## Escape and the end of the turn

A real Escape press during a burst stops the turn. The stop is enforced in the
host, below the model: every later `computer_use` call of that turn throws the
same message until the host is told about a new turn (`beginTurn`). `endTurn`,
called when a turn finishes or is interrupted, stops the input monitor; the lease
is released as each burst ends.

## The lease

The lease file records the owner's process id, its start time, its session and a
heartbeat. A lease is stale and taken over when its owner is gone, when that
process id now belongs to a process that started at another time, or when 30 s
passed without a refresh. A takeover moves the old file aside first so that only
one contender wins.
