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
| Restore | The window is put back only if this burst moved the front: a window the helper raised, or, where Windows refused that raise and the driver took the front itself, the burst's target. It is put back when that window (or another of its program) is still in front, even when the user typed meanwhile; any other window in front means the user or the burst's own click moved on, and it is left alone. When it was not put back the result says why (Windows refused, the window is gone). The pointer is put back only if nobody touched input | after the burst |
| Idle check before the raise | The helper checks the user has been still before it raises anything; if not, nothing moves and the ladder starts the burst again | at `begin` |
| Parked time per turn | All parked calls of one turn together | 600 s |

The 2 s threshold was measured on the development machine: in 180 s with nobody
at it, the idle clock was at 2 s or more for 92% of the time (5 s: 81%, 10 s:
61%), because a keep-awake tool nudges the pointer every 26 s. A longer gate
would starve the ladder there for no gain. It is a starting value; every number
above is `DEFAULT_TIMING` and can be overridden through
`SubprocessComputerUseHost`'s `foreground.timing`.

## Watching the user

A long-lived helper (one PowerShell process, started from a short bootstrap that
reads the helper script from its first input line, so no file is read over the
WSL network share and the script is not limited by the 32 767 characters a
command line allows) installs low-level keyboard and
mouse hooks. Input the machine injected carries a flag and is not counted, so
the burst's own input and a keep-awake nudge are never mistaken for the user;
the system idle clock (which cannot tell them apart) is used only to make the
gate more careful, and it ignores the span of the ladder's own bursts. A poll
answers in about 0.5 ms; starting the helper takes about 0.8 s warm. If the
hooks cannot be installed the burst is refused (`monitor_unavailable`): the
ladder never runs unwatched.

### When the helper is not running

A helper that has ended is replaced, quietly, before anything else happens:

- A cached monitor reports `running === false` (the optional `running` member of
  `ForegroundMonitor`; `WindowsInputMonitor` answers from its process). The
  ladder disposes it and starts a fresh one before the next call.
- If the first look or `begin` of a run fails (the helper died or hung), nothing
  has been sent yet, so the monitor is dropped and the run goes again once with
  a fresh helper. A second failure is a `monitor_unavailable` block carrying the
  real reason; `ladder.run` does not reject.
- A start that fails is retried once at once. After two failed starts in a row
  the failure is remembered until `endTurn` and later calls in the same turn get
  the same block without another compile; the next turn tries again.
- A helper that ends in the middle of a burst is never restarted inside it: the
  burst stops at its next check with "the keyboard-and-mouse helper stopped
  during the action". The helper cannot put the window and cursor back once it
  is gone; the next call gets a fresh one.

The helper's error stream is kept (the last 2 KB) so the reason names the cause:
`could not start Windows PowerShell (<error>)`, `the Windows helper stopped while
starting (exit code N): <last stderr line>` and `the Windows helper stopped
(exit code N)`. PowerShell's CLIXML progress records ("Preparing modules for
first use") are not a cause and are dropped; its error records are read. The
helper script also catches a failed compile of its hook library (antivirus,
Constrained Language Mode) and greets with `ok: false`, the `hookError` and the
`languageMode`, so a blocked compile arrives as a readable reason.

What the model reads: the `monitor_unavailable` block states the cause and that
nothing was sent. Where controls by ref are a real alternative (display actions
and window actions) it adds that `ui_act` still works in the background. When
`ui_act` itself fell back to the screen (a refused background click, choosing by
keyboard) it says instead that the control could not be pressed in the background
and the screen could not be used, and to try another control or ask the user. The
bare cause is also on the block as the optional `reason`.

Windows lets a program take the front only if it has just been given input, so
the helper unlocks the raise with a tap of an unassigned key (flagged as
injected, so it is never counted as the user's) and, failing that, attaches to
the front window's input queue. The same steps put the previous window back.

The helper is also the watchdog. If the program that started it dies, its input
closes; the helper then puts back what a burst in progress moved and deletes the
lease file, whatever the lease says.

## Text sent to a classic edit control

The same helper also reads and writes classic Win32 edit and rich-edit controls
by window message, which needs neither focus nor the screen and so does not use
the ladder, the lease or the idle gate. `set_value` on such a control (the driver
reports no value pattern for it) sends `WM_SETTEXT`, and `type_text` into a
window whose focused control is one sends `EM_REPLACESEL` at the caret; the
focused control counts only when it lies inside the window that was chosen (a
dialog of the same program does not), and a focus that is not an edit control is
not replaced by a lone edit control elsewhere in the window. A window that was
never activated has no focus window on its thread; if no other window of the
thread is active either, its single edit control is the target, but only if it is
enabled, is not the inner field of a combo box and fills at least half of the
window; otherwise it is not used and the text goes the ordinary way. Both are
read back with `WM_GETTEXT`. A program running with higher rights refuses the
message (UIPI): that is `not_delivered` with the reason, and the model is told to
ask the user. A read-only control is `not_delivered`; a program that does not
answer in time is `delivered_unverified`. Where the control is not a classic edit
control the action takes the driver's path as before.

## Selecting a list or tree row

A row that can be invoked (a file row) is selected by the same helper through
its selection pattern, which selects without opening; the driver's click on such
a row invokes it. The helper finds the row in the chosen window by role, name and
automation id (and, among equals, by place), selects it and reports whether it
reads as selected. In a folder window it selects through the shell's own view
(select, clear the others, no focus, no scrolling): the accessibility selection
pattern gives that window's item view the focus, which brings the window to the
front, so it is only the fallback for other programs. Like the edit control it
needs neither the screen nor the lease.

## An input that had no effect

A background input the driver cannot confirm (text, a key combination) is judged by reading the window several times over the time its effect
would take. There are three outcomes besides "the effect was seen":

| The reads show | Result | Next |
|---|---|---|
| The window never changed, no window of the program opened, the text control the text went to holds the same text, and the window was not changing by itself | `delivered_unverified`, `retrySafety: safe`: nothing in the window took the input | the input is sent **once more on the screen**, through the whole ladder (idle gate, lease, shortest burst, restore) and judged again |
| The window changed, but not in a way that shows this input did it (or the text control changed without the text) | `delivered_unverified`, `retrySafety: unsafe`: "sending it again could do it twice" | never retried |
| Too few reads, nothing to read, a window that changes by itself, a text control that could not be read, a person at the keyboard during the burst | as before: `delivered_unverified`, `unsafe` | never retried |

A read that left something out (a name or value longer than the 240 characters kept,
or a walk cut at its cap) never proves that nothing changed, and a shortcut carried
out as a menu command is never sent again on the screen: the app was handed it.
Before a menu item's state is read the window is asked to prepare the popup, as
opening the menu would, so an item an app greys lazily is refused.

A control's `selected` and `disabled` state counts as the window changing, so a
click that only flipped a state is an effect, not "no effect". The retry is made
once and only when the first attempt was a background one and no `delivery_mode`
was asked for; `delivery_mode: "background"` forbids the screen and
`delivery_mode: "foreground"` is already on it. Keys whose effect the controls of
a window do not show (arrows, Tab, Home, End, Page Up and Down, a modifier alone),
keys that edit or undo in place (Enter, Backspace, Delete, Space, and Ctrl with Z, Y, X or V)
and scrolling are never judged this way, and neither is a click: what a click usually
does (focus, a caret, a text selection) is not in the controls, so a window that
held still proves nothing about it and it stays `sent, not confirmed`. A retry that was already on the screen
(the driver said the window cannot take background input) is not repeated; its
answer is final.

The answer after the retry is final whatever it is. If the retry shows the effect,
the result is `delivered_verified` and its detail begins "The first attempt, in
the background, had no effect". If the window still did not change, it is
`delivered_unverified`, `safe`, and says that nothing in the window takes this
input (for text, that no field has the focus, so click the field first). If the
retry could not run because the person is using the keyboard or mouse, or another
session holds the screen, it is `not_delivered`, `safe`, and begins "Waiting for
you to be idle": nothing more was sent, and it is safe to send it again once the
keyboard and mouse are still. A refusal of the screen, a locked computer or a
window above this program's rights is named in the same way.

## A task is done on the person's computer while they use it

The owner's rule is that a task is done while the person is touching the screen,
or the result says exactly why it was not. The order is fixed, and each step is
checked by reading the window before the next one is taken:

1. **Background routes first, no screen at all.** A shortcut with a modifier
   (`ctrl+o`) whose effect is a command of the window's classic menu is carried
   out as that command: the helper reads the window's menu (`GetMenu`), finds the
   item that names the combination after its tab ("Open...  Ctrl+O"), and sends
   the window message that clicking the item sends (`WM_COMMAND` with the item's
   id). No key is pressed, nothing is raised, no lease is taken. A disabled item,
   a window with no classic menu and a modern window (whose menu is not a menu of
   the system) have no such item and the key goes the ordinary way. Text for a
   classic edit control goes by message too (see above), and a control with a
   pattern is driven by `ui_act`. The result is judged like any other input: the
   effect is read from the window.
2. **Only when no background route had an effect: the screen**, once, through
   the whole ladder with the product's short timing (`idleMs` 2 000 ms,
   `approvedIdleMs` 500 ms), never the long idle a test uses. The person counts as
   using the computer while any key or mouse button is held down, however long ago
   it went down. While they keep using it the gate waits for the next short pause
   (it re-reads every 50 ms); after `userActiveWaitMs` it asks once through the
   permission review, and where nobody can be asked it parks for a bounded time
   (`parkMs`, `parkTurnMs`). It never gives up silently: the result is
   `not_delivered` with the reason in words. If a person's input arrives between
   the last look and the send, the burst is stopped with nothing sent, the window
   and pointer are put back, and the input waits for the next pause and goes then
   (up to three times, then the result says nothing was sent and it is safe to try
   again). Input that is already out when the person interferes is never repeated
   (`unsafe`).
3. **Retry safety comes from observation.** A first attempt that provably had no
   effect (see the next section) is sent again once, on the screen; one that
   changed the window in a way that cannot be tied to the input is never sent
   twice and the result says so.

What each kind of window supports on this computer (Windows 11, measured with real
windows the test harness started): a classic Win32 window with a menu (System
Information) takes steps 1 and 3 in the background with no foreground change and no
pointer movement; a window built on the newer toolkit exposes its menu bar to the accessibility tree
but its opened menu is not readable from outside the window, so a shortcut there
(`ctrl+o`) needs the screen; a page in the browser exposes no focused element while
its window is in the background, so text for it needs the person to have clicked a
field first (the click is itself a window input).

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
| `monitor_unavailable` | Real input cannot be observed (the cause is named) | Ask the user to do the step; for display and window actions, controls by ref still work; from `ui_act`, try another control |
| `locked_desktop` | LockApp, LogonUI or winlogon in front | Ask the user to unlock; never work around it |
| `uac_prompt` | consent.exe in front | Ask the user to answer it |
| `secure_desktop` | The input desktop is not `Default` | Ask the user to answer it |
| `elevated_target` | The target, or the window in front, has a higher integrity level than this process | "An administrator window is in front; Namzu cannot type into it": ask the user; never work around it |

All of them are `not_delivered` with `retrySafety: safe`.

## Input that Windows drops

Windows silently discards input from a process to a window that runs at a higher
integrity level (UIPI), and the `SendInput` call still succeeds. Two defences
sit in the helper, which reads the mandatory integrity level of a process
(`OpenProcess` with `PROCESS_QUERY_LIMITED_INFORMATION`, then
`GetTokenInformation` with `TokenIntegrityLevel`; low 0x1000, medium 0x2000,
high 0x3000, system 0x4000):

1. **Before the burst.** The gate compares the window in front, and the target,
   with the helper's own level. A process above it, or one whose level cannot be
   read, is `elevated_target` and nothing is sent. `MonitorState` carries
   `selfIntegrity`, `foreground.integrity` and `target.integrity` so a refusal
   can be explained; `elevated` means "above us".
2. **After the burst.** A burst declared as sending input (`sendsInput`) records
   the system's last-input tick (`GetLastInputInfo`) right after the raise, and
   compares it at `end`. A tick that did not move while nobody else typed means
   Windows dropped the input only when a window above us was positively read to
   be in front at the end (`frontElevated`; an unreadable window is not a yes):
   the outcome then carries `inputLanded: false` and the action is
   `not_delivered` with `retrySafety: safe` ("An administrator window is in
   front; Namzu cannot type into it."). Otherwise a tick that did not move proves
   nothing, because input delivered as posted messages does not move it, and no
   claim is made. The unlock tap the helper sends before a raise is taken
   before the tick is read, so it does not count.

The low-level hooks that watch for a person see nothing typed into a window
above the helper's level, so the in-burst guard cannot tell a person there from
silence. Each `checkpoint` therefore also stops the burst
(`BurstInterrupted('administrator_window')`) when such a window has come to the
front; the next step is not sent. Only a window whose integrity level was read
and is above ours counts: no front window, or one that cannot be read, never
stops a burst.

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

## A cancelled turn

The `computer_use` tool hands its call's `AbortSignal` (the turn was
interrupted, Esc included) to every host method as a trailing `signal`
argument. The host makes it the signal of every driver call and foreground
burst made for that call:

- The call stops waiting at once. An action that may already have been sent
  (the driver had the request, or an earlier step of the same action went out)
  answers `delivered_unverified` with `retrySafety: unsafe`; one that provably
  was not sent yet answers `not_delivered`, `safe`. A read (a screenshot, a
  window list, a tree) throws `cancelled`.
- The driver is not stopped. A request the caller abandoned stays in flight
  until it answers or its own timeout stops the driver.
- A foreground burst is not restored under it. The window and the cursor are put
  back, and the lease released, only after those abandoned requests have
  finished (`LadderRequest.settle`); the caller is answered without waiting for
  that, the next burst and `endTurn`/`dispose` wait for it.

## A locked computer

Before a host method reads or acts, the host asks the helper whether the
computer is locked: the input desktop is not `Default`, or LockApp, LogonUI or
winlogon is in front. If it is, a read throws `ComputerUseLockedError` (code
`computer_locked`) and an action answers `not_delivered`, `safe` with the text
"The computer is locked (or a system prompt only the user can answer has the
screen), so nothing was done or read. Ask the user to unlock it, then continue.
Do not try to work around it." A desktop name the helper cannot read, or a
helper that cannot start, is "unsure" and counts as unlocked. A capture is
checked again afterwards: one taken while the screen locked is dropped, because
it shows nothing current. The check costs one round trip to the running helper;
the first one in a turn starts it.

## The lease

The lease file records the owner's process id, its start time, its session and a
heartbeat. A lease is stale and taken over when its owner is gone, when that
process id now belongs to a process that started at another time, or when 30 s
passed without a refresh. A takeover moves the old file aside first so that only
one contender wins.
