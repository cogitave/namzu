---
type: Guide
title: What Desktop keeps across a restart
description: One owner for each fact Desktop shows again after a close, the interface-state store and its registry, how a quit differs from a crash, and what is never kept.
resource: packages/desktop/src/main/state-store
tags: [desktop, state, restore, sessions]
generated:
  by: claude-code/sonnet-5.5
  at: 2026-11-19
---

# What Desktop keeps across a restart

Closing Namzu and opening it again should leave you where you were. That works because every fact
has exactly one owner, chosen by what the fact is about.

| Kind of fact | Owner | Read by |
|---|---|---|
| A conversation's own content or measurement: its history, its last context figure, its outputs, how its last turn ended | the session log | host reads that start no engine |
| The window and its interface: layout, panes, collapsed sections, panel tabs, window mode | the interface-state store, in the main process | the page, through one reader |
| Preferences the main process acts on, engine configuration | `desktop-settings.json` and the engine config | unchanged |

Nothing about a conversation is copied into the store. The context figure in particular is read
back from the log every time, so it can never disagree with it.

## A conversation's own facts

The host answers these as display reads: they read the log and static tables, and never attach an
engine session. Actions (sending, changing a mode) still need an engine.

- `namzu/session/context` falls back to the log when no engine holds the conversation. It returns
  the last count the log holds (`stored: "record"`), or, when none was ever recorded, an estimate
  from the stored messages (`stored: "estimate"`) only where the model's window is known from the
  log or the model table. With neither it stays `null` and the panel says "Not measured yet". The
  report is always `approximate`, and carries only the total and the free room: no system prompt
  or tool list is read without an engine.
- `namzu/conversations/history` adds `usage` (the same figure, which fills the context ring at
  once), `lastTurn` (`completed`, `cancelled`, `failed`, `paused`, or `interrupted` when the log
  stops inside a turn, the mark a crash leaves) and `environment.cwd`.
- A live usage notice from an engine always replaces what was read back.

The reading lives in `integrations/sessions/stored-context.ts`; the terminal app's resume can use
the same function.

## The interface-state store

`packages/desktop/src/main/state-store/` holds one file, `view-state.json` in the app's data
folder: `{ version, cleanShutdown, savedAt, legacyImported, entries }`, each entry a string and
the time it was written.

- **Registry** (`shared/state-registry.ts`). Every key is declared once: its scope (`app`,
  `window`, `project` or `conversation`), its exact name or name prefix, its size cap, its restore
  policy and, for a family that grows with use, the most entries kept. Key names are the strings the
  page used in `localStorage`, so the migration is a copy and no stored layout is reshaped. An
  unknown key is refused on write and dropped on load; a value over its cap is refused, never cut.
- **Writes** are atomic (a temporary file, then a rename, so an interrupted write leaves the old
  file whole), debounced by 500 ms, and flushed on quit, when a window closes and when a renderer
  process dies. A family past its entry cap drops the entry written longest ago. The page cannot
  write `window.mode:*`; only the main process does.
- **Reading.** The preload reads the snapshot synchronously before the first paint, so a restored
  window is never drawn with defaults first. `public/theme-boot.js` reads the same snapshot for the
  theme and fonts. The page sees a `Storage`-shaped object (`renderer/view-state.ts`), so existing
  readers work unchanged, and `useStateKey(key)` is the one hook for new code. A change in another
  window arrives as the `storage` event the readers already listen for. A test fails if renderer
  code touches `localStorage` outside that module (one end-to-end test flag is allowed).
- **Migration.** On first start after the update the page hands over the keys it kept in
  `localStorage` that the registry declares; main stores them (a key it already holds wins), sets
  `legacyImported`, and the page deletes the keys main took. It is idempotent: a second window
  repeating it changes nothing. A file written by a newer Namzu is read-only here and never
  overwritten; an unreadable file is moved to `view-state.json.unreadable`.
- **Removing a conversation** drops its per-conversation keys (presentation, panel tabs).
- **Window mode.** A window's maximized and full-screen flags are written by the main process
  (`window.mode:<window id>`) and applied when the window is created; the saved bounds are clamped
  to a connected display as before.

## How it was closed

`cleanShutdown` is written false when the app starts and true as the last step of a quit, after
everything is flushed. A window that is still alive may write after that (a resize, a late
renderer message): the write is kept, but the file keeps saying the run ended cleanly, so the next
start is not mistaken for a crash.

| Kind of key | Quit, update restart, reboot | Close to the tray | Crash or kill |
|---|---|---|---|
| `always` (layout, panes, sidebar, appearance, panel open, panel tabs, window mode) | restored | untouched, the process is alive | restored from the last checkpoint (at most the last 500 ms is lost) |
| `soft` (a conversation's presentation, such as which panel tab was in front) | restored | untouched | reset to its default |

After a crash nothing reopens a dialog or resumes a half-done action: no message is sent again and
no tool runs again. A conversation whose last turn is `interrupted` in the log says so honestly,
whatever the close state, so a crash needs no flag.

## Never kept

Secrets, tokens and cookies (they have their own stores); the contents of a page in the browser pane
or an extension view; the clipboard; a live shell (only a terminal's ended screen, as before);
full transcripts (they are in the log); transient dialogs, popovers and menus; and any value over
its key's cap.

## Not yet moved

Drafts, send options and folded sidebar sections (kept by the main process already) and the pane
layout across windows (the workspace file) stay where they are. Per-conversation scroll, terminal
app prompt history, browser pane tab addresses and the last Settings section are later steps.
