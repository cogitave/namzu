---
type: Reference
title: namzu spaces (preview)
description: A sidebar of spaces and sessions beside a tiling of live Namzu panes in tabs, in one terminal; its keys, the mouse, starting a session on an account, how tabs and pane trees are remembered and restored, the prefix setting, what happens when a session stops, and what the preview does not do yet.
resource: packages/cli/src/commands/spaces.ts
tags: [cli, spaces, terminal, preview]
status: draft
generated:
  by: claude/sonnet-5.5
  at: 2026-10-31
---

# namzu spaces (preview)

`namzu spaces` opens one terminal with a sidebar on the left and the selected space on the right.
The sidebar lists your **spaces** on top, which are project folders, each with one dot for the most urgent thing in it. Below them it lists every **session** of the selected space, each with its own dot.
A space has one or more **tabs**, shown as a bar across the top of the workspace area with a "+" to add one, and each tab is a tiling of **panes**. Every pane is a whole Namzu running in its own terminal, so a pane that stops does not take the others down. There are no plain shell panes.
This is a preview, and the plain `namzu` command is unchanged.

Options after `spaces` go to the first session, so `namzu spaces --model <name>` starts it on that model.
Sessions you add later (a new tab, a split) start with the default options; a new tab can start on an account you pick (see below), and a split starts on the account of the pane you split.
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
Showing a tab, or focusing a pane in it, clears the blue mark of the panes on screen: a pane finished in a split beside the focused one counts as seen, one in another tab does not.

The dots come from what each session reports about itself, not from reading its screen: every session publishes a live record and answers a ping, and the host reads the records as they change and asks each session directly every few seconds, so a change that was never written is still caught. A turn that begins and ends between two reads can still be missed when the file watcher is unavailable; the host then re-reads once a second.

## Panes and tabs

With more than one pane in a tab every pane has its own square border: the focused pane's is light blue and the rest are dim grey, and neighbours' borders touch. A lone pane has no border. Each session's terminal is sized to the inside of its pane, so it redraws when you split, close, resize or zoom, and when the terminal or the sidebar changes size.

A split halves the focused pane and the new pane, a new session in the space's folder, takes focus. A border can be moved between 10 and 90 percent of its split, and no pane gets less than 12 columns or 5 rows (border included); a split that would go below that is refused with a note at the bottom. **Zoom** gives the focused pane the whole area, keeps its border and puts a `Z` after the tab's number; moving focus while zoomed moves the zoom with it, and splitting brings the layout back.

Closing a pane lets its neighbour take the room and focus, without asking. The last pane of a tab closes the tab. The last pane of a space's only tab asks to close the space; a space always keeps one tab.

While the prefix, resize or navigate mode is active a bar at the bottom of the workspace area names the mode (`PREFIX`, `RESIZE`, `NAVIGATE`) and the keys it takes. It is drawn over the last row and never changes the panes' size.

## Keys

Everything you type goes to the focused pane except the prefix, `ctrl+b` by default. The prefix starts a command: press it, then one key, and the keyboard returns to the pane.

| Key after `ctrl+b` | What it does |
| --- | --- |
| `ctrl+b` | Send one `ctrl+b` to the pane. The composer uses it to move the cursor left. |
| `esc` | Cancel. |
| `v`, `-` | Split side by side, or top over bottom. |
| `h` `j` `k` `l` | Focus the pane to the left, below, above or right. |
| `H` `J` `K` `L` | Swap the pane with its neighbour in that direction. |
| `tab`, `shift+tab` | Focus the next or previous pane. |
| `x` | Close the pane. |
| `z` | Zoom the pane, or bring the layout back. |
| `r` | Resize mode: `h`/`l` (or the arrows) move the nearest vertical border left or right, `j`/`k` the nearest horizontal one down or up, whichever side of the border the focused pane is on; with no such border on the pane's own edge in that direction, the one on its opposite edge moves. `esc` or `enter` ends it. Each key moves the border by 5 percent of its split. |
| `c`, `T`, `X` | New tab, rename the tab (an empty name goes back to its number), close the tab. The last tab of a space cannot be closed. |
| `n`, `p`, `1` to `9` | Next or previous tab, or tab by number. |
| `N`, `W`, `D` | New space from a folder you type, rename the space, close the space with all its panes (it asks first). Closing the last session quits. |
| `P` | Rename the pane (its row in the sidebar). |
| `w` | Space navigation: `up`/`down` (or `j`/`k`) show the previous or next space, `tab` moves between its panes, `enter` opens it (starting what has not started), `esc` leaves. |
| `b` | Hide or show the sidebar. |
| `q` | Quit. It asks first while a session is running. |
| `?` | A one-line reminder of the pane keys. |

A new tab (`c`) first asks which account to start on when you have added accounts (see below), then asks for the tab's name; an empty name keeps its number. A split does not ask.

Pasted text is never read as the prefix.

## Accounts

Each session row shows the label of the account its conversation runs on, when that is not the provider's usual sign-in. The label follows `/auth` inside the session: switch account there and the row changes within a moment.

When a session's account has used up its allowance, the row gets a yellow note under it, "limited until 3:40 pm" when the provider said when it returns and "may be limited" when it did not. Open the session and press `enter` to **continue with another account**, as in a plain session ([Accounts in the terminal](accounts.md)); the note goes when the session is on an account that works.

With at least one account added, `n` asks which account the new session starts on. The list is the usual sign-in first, then your accounts; it opens on the account this space last used, so `n` then `enter` repeats it. `j`/`k` choose, `enter` starts, `esc` cancels. With no accounts added, `n` starts at once.

A session started on an account runs on that account's provider and model, so a provider or model you set for the host through `NAMZU_PROVIDER` or `NAMZU_MODEL` does not apply to it. A session on a Codex account also gets that account's own `CODEX_HOME`, so the tools it runs sign in as that account. Accounts are added and removed inside a session with `/auth`, never in the host.

## Remembering your layout

Your spaces, their tabs and pane trees (split directions, ratios, zoom, tab names, which pane has focus, and each pane's name, conversation and account) and which space was shown are kept in `spaces.json` under the Namzu home, readable only by you. The file's `version` is 2; a version 1 file from an earlier preview is read as one tab per session, in the same order, with the session that had focus as the shown tab, and is rewritten as version 2. Start `namzu spaces` again and they come back:

- Every saved session is listed, and none is started until its tab is shown. The tab you were on opens at once, all its panes together.
- A session that had a conversation opens it again with the account it was on. One that never got a reply starts fresh.
- Run it in a folder that is not a space yet, or give it options (`namzu spaces --model <name>`), and a new first session starts there instead, beside the restored ones.
- Closing a pane removes it from the layout. Its conversation stays, and `namzu resume` finds it.
- A conversation that is already open in another terminal is not opened a second time. The session says "open in another terminal" and starts when you press `enter` after closing it there. A plain `namzu` that is idle between turns does not announce its conversation, so only a terminal in the middle of a turn, or one started by a spaces host, is noticed.

## No pseudo-terminal

`namzu doctor` has a row, "terminal.pty", that says whether a pseudo-terminal can be opened on this machine. When it cannot, it says why and how to get one, and `namzu spaces` starts a single plain session with the same pointer.

## Mouse

Click a pane to focus it, a tab to open it, or the "+" to add a tab. Drag a border between two panes to resize them. Click a space or a session in the sidebar to open it. Scroll over the sidebar to move its lists, and over a pane to read its history (the pane under the pointer scrolls, whether or not it has focus); a line at the bottom of that pane says you are scrolled back, and typing or scrolling down returns you to the live screen. The host takes the mouse, so selecting text with the pointer needs the terminal's own override, usually holding `shift`.

## Colours

The host draws its borders, tab bar and mode bar in a fixed palette: light blue (137, 180, 250) for the focused border and the active tab, dim grey-blue (108, 112, 134) for other borders and quiet text, on a dark blue bar. When `COLORTERM` is not `truecolor` or `24bit` it uses the nearest of the terminal's 16 colours instead, with resting tabs drawn on bright black so they stay apart from the bar. The sidebar's dots still use the 16 colours.

## Changing the navigate key

```yaml
tui:
  spacesPrefix: ctrl+a
```

The value is `ctrl+` and a letter, or `ctrl+space`. `ctrl+c`, `ctrl+d` and `ctrl+z` are refused because the session needs them, as are the keys that are Tab, Enter, Backspace and Escape. A refused value names `tui.spacesPrefix` in the error.

## When a session stops

Its pane keeps the last screen with a line at the bottom saying so, and its sidebar row turns grey and says "ended" or "stopped", The conversation is saved. The other sessions keep running, `ctrl+b` then `x` closes the pane, and `ctrl+b` then `q` leaves.

## When there is no terminal component

Spaces needs a pseudo-terminal binding; `namzu doctor` checks it. The CLI ships the prebuilt `@lydell/node-pty` first and falls back to `node-pty`, so a Linux machine without a compiler normally has one. If neither loads, `namzu spaces` prints one line saying why, points to `namzu doctor`, and runs a single plain session instead. It needs an interactive terminal and exits with an error otherwise.

## What it does not do yet

Quitting ends every session; they come back when you start again but are not kept running in the background (there is no detach and reattach). There is no copy mode, goto overlay or worktree grouping. A session moved to a Codex account with `/auth` keeps the `CODEX_HOME` it started with until it is opened again. There is no keyboard enhancement protocol inside a session (shifted Enter and similar keys arrive as the plain key). The terminal title and hyperlinks a session sets are not forwarded, and a session that asks for mouse reports does not receive them.
