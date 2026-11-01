---
type: Reference
title: namzu spaces (preview)
description: A sidebar of spaces and sessions beside a tiling of live Namzu panes in tabs, in one terminal, opened with the left arrow from a plain `namzu` or by `namzu spaces`; its keys, the mouse, starting a session on an account, how tabs and pane trees are remembered and restored, overlays (modals, context menu, go to, keybinds, menu), the prefix setting, selecting and copying text with the mouse and the `tui.mouse` and `tui.copyOnSelect` settings, what happens when a session stops, and what the preview does not do yet.
resource: packages/cli/src/commands/spaces.ts
tags: [cli, spaces, terminal, preview]
status: draft
generated:
  by: claude/sonnet-5.5
  at: 2026-10-31
---

# namzu spaces (preview)

`namzu spaces` opens one terminal with a sidebar on the left and the selected space on the right.
The sidebar has two sections split by a rule. On top are your **spaces**, which are project folders: a row is the most urgent state dot and the folder's name in bold, and under it the git branch with `↑` commits ahead and `↓` behind its upstream (a note such as "needs approval" takes the branch's place while something waits for you). The shown space has a faint background tint; in space navigation the cursor row has a stronger one. The last row of the section holds **new** (a space in the focused pane's folder, started at once) and **menu**. Below the rule is **agents**: every session of every space, two lines each (the dot and its space's name, then its tab, pane name and account, for example `tab 2 · session 3 · work`). Click an agent to focus that pane, switching space and tab. The header's right-hand word, `grouped` or `priority`, is a toggle: grouped follows the spaces, priority puts blocked first, then finished, working and idle, newest change first. The branch is read in the background (never before the first frame), again every few seconds and when a space is shown, and a folder outside git shows no branch.
A space has one or more **tabs**, shown as a bar across the top of the workspace area with a "+" to add one, and each tab is a tiling of **panes**. Every pane is a whole Namzu running in its own terminal, so a pane that stops does not take the others down. There are no plain shell panes.
This is a preview. A plain `namzu` opens exactly as before, one conversation full screen with nothing else visible; the screen below is one key away (see the next section).

Options after `spaces` go to the first session, so `namzu spaces --model <name>` starts it on that model.
Sessions you add later (a new tab, a split) start with the default options; a new tab can start on an account you pick (see below), and a split starts on the account of the pane you split.
Every session starts in its space's folder and inherits the environment the command started with.

## Opening it from a conversation

In a plain `namzu`, press `←` on an empty message box to open this screen. The sidebar is on the left; on the right is the current tab of the selected space, live, with the conversation you were in as one of its panes (it becomes a tab of its folder's space, or the pane that already carries its conversation id in `spaces.json`; it is never started a second time). Nothing else is started until you move to it.

- `↑` and `↓` move through the sessions in the order the agents list shows them, and the space, tab and panes on the right follow. A session you land on starts the moment you land on it.
- `→` opens the selected session full screen. For the conversation you came from that is the plain screen again, with the whole conversation printed in your terminal's own scrollback exactly once. For any other session the host draws it alone on the whole terminal, sidebar hidden.
- `enter` types into the selected pane while the split stays; `←` on that pane's empty message box brings the keys back to the sidebar (`ctrl+b` then `w` does too), and `←` on the empty message box of a session shown full screen goes back to this screen.
- `ctrl+c` with the sidebar focused asks to quit every session. `/exit` in the conversation you came from, or its double `ctrl+c`, ends the process and hangs up the others; spaces and conversation ids are saved as for any quit.
- `ctrl+b` is the prefix everywhere on this screen, the sidebar included: press it, then one key (`q` asks to quit, `b` hides the sidebar).
- Ending the conversation you started from (`/exit`, or `ctrl+c` twice) while another session is mid-turn brings this screen up with the quit question; answering no keeps everything running. A session shown full screen that ends puts you back on this screen.

`←` only counts on an empty message box with nothing attached and no `shift`, `ctrl` or `alt` held. If you have just emptied the box by editing (within 2 seconds), the first `←` only shows "Press ← again to open spaces" and a second one within 3 seconds opens it. Presses closer than 150 ms are key repeat and are ignored, and so are presses within a second after one that opened or armed. Sending a message does not count as editing it away.

Where this screen cannot be opened (Windows, or a terminal that is not interactive, or no pseudo-terminal component), `←` on an empty message box opens the agents cockpit as it always did. Where it can, the cockpit is reached with `↓` (the agents rail, and the cockpit when there is no row) or `/agents`, and the footer no longer offers `← N agents`.

`namzu spaces` opens the same screen directly, with every session a separate process.

A session started by the host is itself a `namzu`, but it does not open a spaces screen of its own: its `←` (under the same rules) writes a private terminal message the host reads and removes from the session's output, and the host goes back one level (from full screen to this screen, from a pane to the sidebar).

## The dots

| Dot | Meaning |
| --- | --- |
| red | A session needs your approval before it can go on. |
| teal | A session finished a turn while you were looking at another one, and you have not looked since. |
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
| `N`, `W`, `D` | New space (a modal asks for the folder, filled in with the focused pane's), rename the space (a modal with the name filled in), close the space with all its panes (a modal asks first). Closing the last session quits. |
| `O` | Open another folder as a space: a modal asks for the folder's path, and an existing space for that folder is shown instead of a second one. |
| `P` | Rename the pane (its row in the sidebar). |
| `w` | Sidebar navigation: `up`/`down` (or `j`/`k`) move through the sessions in the sidebar's order and the space and tab shown follow (a session is started only on the screen opened from a conversation), `right` (or `l`) opens the session full screen, `tab` moves between the panes of the tab, `enter` types into the selected pane, `esc` leaves, `ctrl+c` asks to quit. |
| `b` | Collapse the sidebar to a thin rail of index-and-dot rows, or expand it. |
| `g` | Go to: an overlay with a filterable tree of every space, tab and pane. |
| `s` | The menu overlay (the same as the sidebar's "menu"). |
| `q` | Quit. It asks first while a session is running. Panes do not outlive the host, so there is nothing to detach from; a multiplexer's detach key has no counterpart. |
| `?` | The keybinds overlay. |

While the prefix, space navigation or resize mode is active, a bar on the bottom row shows a coloured chip (`PREFIX`, `NAVIGATE`, `RESIZE`) followed by the keys that work, keys in bold light blue. Nothing is drawn there otherwise, and the sidebar carries no key list.

The keybinds overlay is printed from the same list the host runs, so it always matches the keys above. Both it and the table are the whole map: no other key does anything after the prefix.

A new tab (`c`) first asks which account to start on when you have added accounts (see below), then asks for the tab's name; an empty name keeps its number. A split does not ask.

Pasted text is never read as the prefix.

## Accounts

Each session row shows the label of the account its conversation runs on, when that is not the provider's usual sign-in. The label follows `/auth` inside the session: switch account there and the row changes within a moment.

When a session's account has used up its allowance, the row gets a yellow note under it, "limited until 3:40 pm" when the provider said when it returns and "may be limited" when it did not. Open the session and press `enter` to **continue with another account**, as in a plain session ([Accounts in the terminal](accounts.md)); the note goes when the session is on an account that works.

With at least one account added, `c` asks which account the new tab's session starts on, in a centred modal. The list is the usual sign-in first, then your accounts; it opens on the account this space last used, so `c` then `enter` repeats it. `j`/`k` or a click choose, `enter` starts, `esc` or a click outside cancels. With no accounts added, `c` starts at once.

A session started on an account runs on that account's provider and model, so a provider or model you set for the host through `NAMZU_PROVIDER` or `NAMZU_MODEL` does not apply to it. A session on a Codex account also gets that account's own `CODEX_HOME`, so the tools it runs sign in as that account. Accounts are added and removed inside a session with `/auth`, never in the host; the menu's "accounts" lists them and "add account" opens a session in a new tab where you type `/auth`.

## Remembering your layout

Your spaces, their tabs and pane trees (split directions, ratios, zoom, tab names, which pane has focus, and each pane's name, conversation and account), which space was shown, and the sidebar's choices (collapsed, width, section split, agents order; an optional `sidebar` object, written only when something differs from the default) are kept in `spaces.json` under the Namzu home, readable only by you. The file's `version` is 2; a version 1 file from an earlier preview is read as one tab per session, in the same order, with the session that had focus as the shown tab, and is rewritten as version 2. Start `namzu spaces` again and they come back:

- Every saved session is listed, and none is started until its tab is shown. The tab you were on opens at once, all its panes together.
- A session that had a conversation opens it again with the account it was on. One that never got a reply starts fresh.
- Run it in a folder that is not a space yet, or give it options (`namzu spaces --model <name>`), and a new first session starts there instead, beside the restored ones.
- Closing a pane removes it from the layout. Its conversation stays, and `namzu resume` finds it.
- A conversation that is already open in another terminal is not opened a second time. The session says "open in another terminal" and starts when you press `enter` after closing it there. A plain `namzu` that is idle between turns does not announce its conversation, so only a terminal in the middle of a turn, or one started by a spaces host, is noticed.

## No pseudo-terminal

`namzu doctor` has a row, "terminal.pty", that says whether a pseudo-terminal can be opened on this machine. When it cannot, it says why and how to get one, and `namzu spaces` starts a single plain session with the same pointer.

## Overlays

Questions and names appear in a modal centred on the screen: a box with a border, the rest of the screen dimmed, and buttons. Naming something (new space, open folder, rename space, rename tab, rename pane, the name a new tab asks for) shows a text field with the current name filled in and the buttons `↲ save` (or `↲ open`), `^c clear` and `esc cancel` (on a terminal too narrow for all three, `^c clear` is left out; the key still works); `enter`, `ctrl+c` and `esc` do the same, and a click on a button does too. Closing a space or quitting asks in a red-bordered modal with `↲ confirm` and `esc cancel`; `enter` or `y` confirms and any other key keeps things as they were. Closing a pane never asks. Starting a session on an account, go to, keybinds and accounts use the same kind of modal with a list.

Every overlay closes with `esc` and with a click outside it, and while one is open a click goes to it or closes it, never to what is behind. The context menu and the menu popup are small boxes that do not dim the screen.

- **Go to** (`g`): a tree of every space with its tabs and each tab's panes, with state dots. Typing filters it (any part of a name, ignoring case; a matching space or tab keeps everything under it), `up`/`down` or `tab`/`shift+tab` move, `ctrl+c` clears the filter, and `enter` or a click focuses the row, starting what has not started.
- **Keybinds** (`?`): the key map, scrolled with `up`/`down` or `j`/`k` when the screen is short.
- **Menu** (sidebar "menu", or `s`): accounts (the accounts you have added), add account, sidebar (collapse or expand), keybinds and quit. It does not reimplement settings, which stay where they were.
- **Context menu** (right-click): on a space, Rename, New tab and Close; on a tab, Rename and Close (the only tab of a space asks to close the space); on a pane or an agent row, Rename, Split right, Split down, Zoom and Close. The right-clicked item is shown first, then the choice applies to it.

## Mouse

Click a pane to focus it, a tab to open it, or the "+" to add a tab. Drag a border between two panes to resize them. Click a space or an agent in the sidebar to open it, and drag a space up or down to reorder the list (a line shows where it would land, dropping below the last space puts it last, and the order is remembered); right-click a space, tab or pane for its context menu; click "new" to add a space in the focused pane's folder at once, "menu" for its popup, the grouped/priority word to switch the order, and `«` (`»` on the rail) at its foot to collapse or expand it. Drag the line between the sidebar and the panes to resize it (18 to 36 columns, 26 by default; a double click puts it back), and drag the rule between its two sections to change their shares. Scroll over the sidebar to move its lists, and over a pane to read its history (the pane under the pointer scrolls, whether or not it has focus); a line at the bottom of that pane says you are scrolled back, and typing or scrolling down returns you to the live screen.

## Selecting and copying text

While the spaces screen is up the host asks the terminal to report the mouse, because the sidebar, the tabs and the borders between panes are clicked. A plain `namzu` conversation never does; its text is selected and copied by your terminal as usual.

Inside a pane you can select without any override:

- Drag across the text. The cells are highlighted, and when you let go they are copied. The selection follows the pane's own lines, so scrolling the pane's history with the wheel while you drag, or output arriving, does not move it. Clicking a pane keeps the place it was scrolled to, so text from its history can be selected.
- Double-click a word, or triple-click a line (a line the program wrapped is taken whole). Wide characters (Chinese, Japanese, Korean, full-width forms) count as one character: a selection never cuts one in half.
- Trailing blanks on each line are left out, wrapped lines are joined, and no colours or control characters reach the clipboard. A selection of more than 100,000 bytes is refused rather than cut short.
- The status line says how many characters were sent. Terminals give no confirmation that a copy arrived, so it says "sent". If pasting gives nothing, your terminal does not take the request; hold `shift` (`option` in iTerm2, `fn` in Terminal.app) while selecting to use the terminal's own selection and copy.
- Copying uses the terminal's clipboard request (OSC 52). Inside tmux it is wrapped for passthrough, which needs `set -g allow-passthrough on` (or `set -g set-clipboard on`); with tmux's own `mouse on`, tmux takes the mouse first and only `shift`-drag reaches the terminal. Inside screen it is sent in screen's passthrough frames. On WSL, Windows Terminal takes the request.
- A program in a pane that asks for the clipboard (for example `/copy` in a Namzu session) now reaches your terminal too. Only writes are passed on, only from a session that is on screen (a hidden one gets a short note instead), at most four a second per pane (a request that comes too soon is held and sent when the pause is over, so the last one wins), and the base64 may leave its padding off; a program can never read your clipboard through it.

The sidebar, the tab bar and the borders are not selectable this way; use the terminal's override for them.

Settings, in your config's `tui` block:

```yaml
tui:
  mouse: full         # full (default), scroll (the wheel only) or off
  copyOnSelect: true  # false: ctrl+c copies the selection, esc or a second ctrl+c lets go of it
```

With `copyOnSelect: false` a drag only highlights; `ctrl+c` copies it. With nothing selected, `ctrl+c` still goes to the pane. In `scroll` mode the host reacts to the wheel only, and in `off` it asks for nothing: your terminal selects text itself and the screen is driven with the keys. The environment overrides the setting: `NAMZU_DISABLE_MOUSE=1` is `off` and `NAMZU_DISABLE_MOUSE_CLICKS=1` is `scroll`.

The mouse is switched off again on every way out that can be caught: quitting, an error, `SIGTERM`, `SIGHUP` and `SIGINT`. A process killed with `SIGKILL` cannot clean up, so every interactive `namzu` writes the "mouse off" request once before its first frame; if a shell prints stray `^[[<` characters when the mouse moves after a crash, starting `namzu` again, or `reset`, clears it.

## Colours

The host draws its borders, tab bar and mode bar in a fixed palette: light blue (137, 180, 250) for the focused border and the active tab, dim grey-blue (108, 112, 134) for other borders and quiet text, on a dark blue bar. When `COLORTERM` is not `truecolor` or `24bit` it uses the nearest of the terminal's 16 colours instead, with resting tabs drawn on bright black so they stay apart from the bar. The sidebar uses the same palette: dots are yellow (working), red (blocked), teal (finished, not seen), green hollow (idle) and grey (none); the shown space's name is bold in the main text colour, the others subdued, the shown space's branch is mauve and the rest dim grey, ahead counts green and behind counts red, and the tints are (30, 30, 46) and (49, 50, 68). In 16 colours both tints are bright black, and text that would match it is drawn in the main text colour. A list longer than its section shows a thin scrollbar thumb in the section's last column (not on the rail, which has no room; there the rows are numbered by their last two digits past 99). A terminal too narrow for 40 session columns beside the sidebar shows the rail instead, and below that no sidebar.

## Changing the navigate key

```yaml
tui:
  spacesPrefix: ctrl+a
```

The value is `ctrl+` and a letter, or `ctrl+space`. `ctrl+c`, `ctrl+d` and `ctrl+z` are refused because the session needs them, as are the keys that are Tab, Enter, Backspace and Escape. A refused value names `tui.spacesPrefix` in the error.

## When a session stops

Its pane keeps the last screen with a line at the bottom saying so, and its dot turns grey and its pane says "ended" or "stopped". The conversation is saved. The other sessions keep running, `ctrl+b` then `x` closes the pane, and `ctrl+b` then `q` leaves.

## When there is no terminal component

Spaces needs a pseudo-terminal binding; `namzu doctor` checks it. The CLI ships the prebuilt `@lydell/node-pty` first and falls back to `node-pty`, so a Linux machine without a compiler normally has one. If neither loads, `namzu spaces` prints one line saying why, points to `namzu doctor`, and runs a single plain session instead. It needs an interactive terminal and exits with an error otherwise.

## What it does not do yet

Quitting ends every session; they come back when you start again but are not kept running in the background (there is no detach and reattach). A child session shown full screen is drawn by the host on the alternate screen, so its output is not in your terminal's scrollback (only the conversation you started from is). Quitting from the spaces screen (sidebar `ctrl+c`, `ctrl+b` then `q`, `/exit` or a double `ctrl+c` typed in the conversation's pane, or a termination signal) leaves the alternate screen and prints the conversation's whole history once before the final frame, exactly as quitting a plain `namzu` does. Closing its pane is refused while other panes remain. There is no keyboard copy mode, no scrolling while a drag is held at a pane's edge, and no worktree grouping. A session moved to a Codex account with `/auth` keeps the `CODEX_HOME` it started with until it is opened again. There is no keyboard enhancement protocol inside a session (shifted Enter and similar keys arrive as the plain key). The terminal title and hyperlinks a session sets are not forwarded, and a session that asks for mouse reports does not receive them, right-clicks included: a right-click always opens the host's context menu. The keys for reloading the config, opening a notification target and editing the scrollback have no counterpart, and `s` opens the menu overlay rather than settings.
