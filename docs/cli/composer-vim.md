---
type: Reference
title: Vim keys in the message box
description: Turn on vim's modes for the terminal message box (tui.editorMode or /vim), where the mode is shown, what Esc and Enter do in each mode, the motions, operators, text objects, counts, the one register and dot repeat that are built, and what is left out.
resource: packages/cli/src/tui/vim/machine.ts
tags: [cli, tui, composer, keys, vim, config]
status: stable
generated: { by: process:agent, at: 2026-11-20T00:00:00Z }
---

# Vim keys in the message box

The message box can edit like vim. It is off by default and changes nothing until you turn it on.

## Turning it on

- Type `/vim`. It flips the setting for the running terminal, saves it, and says the new mode in one line: `Editor mode is vim: ...` or `Editor mode is normal: ...`. `/vim on` and `/vim off` name the mode instead of flipping it.
- `/settings` has an **Editor mode** row that does the same.
- Or set it in your user config: `tui.editorMode: vim` (`normal` is the default). `namzu config set tui.editorMode vim` and the Terminal rows of Desktop Settings write the same key; a running terminal reads it at the next start, `/vim` applies it at once. A project file cannot set it (it is your own taste), and a value other than `normal` or `vim` is an error, not a quiet fall back.

## The modes

The box starts in **INSERT**, where every key is the usual key: letters type, Enter sends, Up and Down move through the draft and then the history, Ctrl+R searches the history, Ctrl+V attaches an image, `!` at the start of an empty box makes a shell line, `/` and `@` open their menus. A paste is inserted at the cursor in every mode and does not change the mode. After a message is sent the next draft starts in INSERT again.

| Mode | How you get there | Footer |
|---|---|---|
| INSERT | the start, and `i a I A o O s S c C` | `-- INSERT --` |
| NORMAL | Esc | nothing |
| VISUAL | `v` | `-- VISUAL --` |
| VISUAL LINE | `V` | `-- VISUAL LINE --` |

The mode is written at the left end of the footer line. It is the last item to go on a narrow terminal (every other item, and the hint on the right, give way first); a line too narrow for the words shows no mode rather than cutting it. In NORMAL and VISUAL the cursor is a block over a character, and VISUAL draws the selection reversed.

## Esc and Enter

- **Esc in INSERT** goes to NORMAL, with the cursor one character left (not at the start of a line). **Esc in VISUAL** goes to NORMAL. Neither stops a running reply nor clears the draft: they are vim's Esc.
- An open `/` or `@` menu, and shell mode, take their Esc first: the first Esc closes the menu or leaves shell mode and stays in INSERT, the next goes to NORMAL. A history search keeps its own keys.
- **Esc in NORMAL** with a command half typed (`d`, `2`, `f`) cancels that command and nothing else. With nothing half typed it is Esc as it always was: it stops a running reply, otherwise it is the first press of `Esc again to clear` and of the rewind.
- **Enter** sends in INSERT and in NORMAL, even with a count or operator half typed. In VISUAL it moves down a line. A new line in the draft is still Shift+Enter, Alt+Enter, Ctrl+J or a trailing backslash.
- Ctrl and Alt keys keep their meaning in INSERT and NORMAL and do not change the mode (Ctrl+U and Ctrl+K edit the draft in NORMAL too; Ctrl+R opens the history search; Ctrl+_ undoes). In VISUAL they first leave VISUAL; Ctrl+V still attaches an image.

## What is built

Counts go up to 10000 and multiply (`2d3w` is `6dw`). One unnamed register holds what `d c x s D C S y Y` took; it is not the system clipboard and not Ctrl+Y's kill ring. There are no named registers and no redo.

**Motions.** `h l` and Left/Right (Left on an empty box is the workspaces key as before), `j k` and Down/Up, `Space` and Backspace across line ends, `w W b B e E`, `0 ^ $`, `gg G` (with a count, to that line), `f F t T` with `;` and `,`, `%` for `()[]{}` on the line, and `gj gk` (the same as `j k`, since the box does not know where the terminal wraps). `k` on the first line steps back through the prompt history, as Up does, and `j` on the last line steps forward again, but only while a recalled line is shown; a recalled line replaces the draft. Word classes are letters, digits and `_`, then punctuation, then blanks; an empty line is a word of its own. `$` is sticky for `j` and `k` and ignores a count.

**Operators.** `d c y` with any motion above, doubled (`dd cc yy`), or with a text object; `>` and `<` shift lines by two spaces. `cw` changes to the end of the word. `dw` on the last word of a line stops at the line end and does not join the next line.

**Text objects.** `iw aw iW aW`, quotes `i" a" i' a' i` a``` on the line, and brackets `i( a( ib`, `i[ a[`, `i{ a{ iB`, `i< a<` that may span lines, with a count for the nesting level.

**Commands.** `i I a A o O` (a count repeats the typed text for `i a I A`), `x s S D C Y`, `p P` (characterwise or linewise, with a count), `J`, `r` with a character (Esc cancels), `~`, `u` (undo), `.` (repeat the last change, with its typed text; a count replaces the recorded one), `/` (the history search, the box goes to INSERT), `v V`.

**VISUAL.** Motions and counts, `o` to swap ends, `d x Delete` to delete, `c s` to change, `y` to yank (the cursor goes to the start), `r` to replace, `~ u U` for case, `> <` to shift, `J` to join, `p P` to replace the selection with the register (the replaced text becomes the register), `Y X D C S R` on whole lines, and `i` or `a` with an object to select it.

**Undo.** `u` steps back one change. Everything typed between an `i` (or `o`, `cw`, ...) and the Esc that ends it undoes as one step. Ctrl+_ is the same undo and the last 50 edits are kept.

**Pasted text and images.** A pasted block and an image are one unit, like in INSERT: a motion steps over it, a delete or a yank takes all of it.

## What is left out

- Redo (Ctrl+R opens the history search here), named registers, the clipboard registers, marks, macros, `:` commands, `/` search inside the draft, `*`, `R` replace mode, `X` and `U` in NORMAL, counts for `o` and `O`.
- Dot repeat does not repeat a change made in VISUAL mode.
- `gj` and `gk` move by logical line.
- The two optional settings of other editors (a two-key remap that leaves INSERT, and a switch that hides the mode from the footer) are not built; nothing else reads them.
- `tui.editorMode` is read once at the start. `/vim` changes the running terminal; Desktop has no message box of its own to apply it to, so its Settings row only writes the key the terminal reads.

## For developers

The key handling is a pure state machine in `packages/cli/src/tui/vim/` (`machine.ts`: modes, parsing a command from its keys, motions, operators, registers, dot repeat; `doc.ts`: the draft as grapheme characters, word motions and text objects). It takes the state, the draft, the cursor and one key and returns the new state, draft and cursor and the effects the host performs (`undo`, `history-up`, `history-down`, `history-search`). `Composer.tsx` offers each key to it after the chord and queued-message handling and before the box's own actions, in NORMAL and VISUAL, and for Esc in INSERT; the box applies the result through its usual edit path so markers, triggers and undo stay coherent. `onVimModeChange` tells the host the mode and whether Esc is vim's, so `App.tsx` does not stop a reply on the Esc that leaves INSERT, and `StatusBar.tsx` fits the mode into the footer.
