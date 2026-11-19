---
type: Reference
title: Extensions in Desktop
description: Settings, Extensions in the Desktop app (one row for each extension, Add from file, an extension's own screen with its switch, Today's record, background start, what is collected, settings, licence, notice and record, activity log and Remove), the pages an extension draws in the main pane and the rules they run under, where an extension's own tray mark belongs, and the namzu/extensions methods behind them.
resource: packages/desktop/src/renderer/extensions-section.tsx
tags: [desktop, extensions, consent, jsonrpc]
status: stable
generated: { by: process:agent, at: 2026-11-18T00:00:00Z }
---

# Extensions in Desktop

**Settings, Extensions** (after Tools) is where [extensions](extensions.md) live in Desktop. The
rail's Extensions button opens Settings on it. It is there when the engine offers extensions or
one is added. There is no full-window Extensions page, and nothing about an extension is drawn in
the window's title band or on Namzu's tray icon.

## The list

One row for each extension: its icon, its name in your language, "publisher · version", one state
word with a dot (Recording, Off, Needs your notice, and a few more), and a chevron. A row is one
button that opens the extension's own screen; it carries no row of buttons. While an extension
runs, the word is the one the extension declared for its state in the manifest's chip slot, so a
recorder can say "Recording"; every other word is Namzu's own. **Add from file** sits at the top
right. With nothing added the list says "No extensions yet" and what an extension is.

- **Add from file** opens the system file dialog for a `.nzx` and hands the chosen file to the
  engine. The page never names a path; a dropped or typed path is not a way in. A refusal is
  said in words: "This file was not signed by a publisher Namzu trusts.", "This file was
  changed after it was signed.", "This extension needs Namzu 53.5 or newer." Nothing is
  installed.
- The **install dialog** shows what it asks for, from the manifest only (the same words
  `namzu extension add` prints), with **Continue** (leaves it added, off) and **Cancel**
  (removes it).

## An extension's own screen

Opening a row shows the extension inside Settings: a back arrow, the name, "publisher · version"
and a **Dev key** mark when it is signed with a developer key. The rows, switches and buttons are
Settings' own. From the top:

- **The status row**: the state word, one sentence about it, and the main switch. The switch turns
  the extension on or off. While the notice is unread, or a licence is needed, or an update asks
  for more, the control is the one button that fits instead (Read the notice, Add a licence, Review
  and accept); Namzu opens the **notice screen** only when nothing covers the extension yet: the
  notice in your language, what it asks for, and **I have read this**, which stays off until the
  text has been read to the end. **Not now** writes nothing. The page echoes the notice version and
  the scope hash it showed; the engine refuses an acknowledgement of anything else.
- **Today's record** (the title is the extension's own settings-slot page): three totals (at the
  computer, idle, away) and the day as a ribbon, drawn from the extension's counts while it runs,
  and an **Open today's record** row that opens the page. The rows are asked for by the person's own
  day (local midnight to the next midnight, 500 a page, following the extension's `next` until it is
  null), never by the extension's defaults, which would hand back the oldest days kept. Totals and ribbon are drawn only as far
  as the answer is understood: with no times there is no ribbon, with nothing understood there is
  only the row. There is no score, goal or colour for good or bad.
- **Background**: the **Start when I sign in** switch, with what is true now ("Running in the
  background. It keeps running when Namzu is closed."). Only for an extension that can start then.
- **What is collected**: each kind of data with how long it is kept, a "Never collected" row (the items separated by semicolons), and
  **Records on this computer**, which opens the read-only dialog (each kind with its fields and
  retention, today's counts, and **Show recent rows**).
- **Settings**: the extension's settings rows (the model API key, which nothing uses in this version).
- **Licence**: holder, seats, valid until, and **Change licence** (or **Add a licence**). The dialog
  depends on the kind: a paste box for a key file; for a publisher's service the host the key is
  sent to, the key (kept by Namzu, never shown again), when it was last checked, **Check now** and
  **Release this computer**. An extension with no licence has no such group.
- **Notice and my record**: the notice version, when you read it, and **Read again**.
- **Activity log**: opens the log of what the extension did on this computer.
- **Remove**, last: opens the confirmation, with the choice to delete what it collected.

An update that asks for more shows "An update asks for more. Review it." with the reasons and the
**Review and accept** button; the old version keeps running meanwhile.

## Where an extension's own mark belongs

An extension's recording mark is the extension's own, in its own tray icon, not Namzu's. Namzu's
tray icon and its menu (Open Namzu, Quit Namzu) carry no extension state at all: no dot, no extension
rows, however many extensions run, because none may add anything to Namzu's icon. An own tray icon is
optional for an extension, with one exception the host enforces: an extension that runs in the
background and declares personal data must show its own tray mark while it records (rule `B2`).
Namzu's tray icon is its own mark in a light or a dark tile, chosen from the system's theme and drawn
again when the theme changes.

## The methods behind it

The page turns on only when the engine lists every method of the group `extensions`:
`namzu/extensions/list`, `add`, `license`, `notice`, `acknowledge`, `enable`, `disable`,
`remove`, `grant`, `revoke`, `query`, `settings/get`, `settings/set`, `audit`, `background/get`,
`background/set`, `ui`, `action` and `runner`, plus the
notification `namzu/extensions/state` (`{ id, state, indicator, since }`) on every change, which keeps the list and the extension's screen current. A
refusal the person can read is answered as `{ error: { code, check, message } }`. A secret is
never returned, only whether one is stored and its last four characters. The main process
lets the page call everything except `add`, and `add` only with the file chosen in the dialog.

## The Start when I sign in switch and the licence group

When an extension can start at sign-in, the notice screen has a switch above **I have read this**:
the words (what starting at sign-in means, what the extension shows while Namzu is closed) and the
manifest's default, and the answer is recorded with the acknowledgement. The extension's screen has
the same switch under **Background** and says what is true now: "Running in the background. It keeps
running when Namzu is closed.", "Running while Namzu is open.", or that your computer has switched the
entry off.

## The extension's own pages

An extension's pages are drawn in a slot: a rail entry (an initial and the accent dot) and the
**Open** row of its screen in Settings. A page is a **page of the window**, not a dialog: it fills the
main pane under the window's top bar. Back (the arrow in the strip) and Escape return to where the
person was: the extension's screen in Settings, if the page was opened from there, or the window it
covered. Escape pressed inside the page's own view is reported by the main process, since this window
cannot hear it.

Namzu draws one thin strip above every page, and the strip is not part of the page: a back arrow, the
extension's name, "Page drawn by <publisher>", an info mark whose tooltip says "Namzu never asks for a
key or a password inside an extension page.", and links to Namzu's own **Permissions and notice** and
**Licence** screens, which open that extension's screen in Settings with the dialog. That strip is
what makes a spoofed prompt recognisable. A page's own request to open one of Namzu's screens
(`openNamzu`) goes the same way.

Each page is its own native view in the main process, not part of the app's page: a separate process, no
access to the app's bridge, storage or windows. The renderer only reports where the rectangle is, and a
native view always paints above the app's own screens, so the rectangle is cut to what is really visible:
the part of the slot inside every scrolling area around it and inside the window. When none is visible, or
one of Namzu's own overlays (a dialog, a menu, a notice) lies over the slot, the view is given no area, so
a page can never cover Namzu's strip, title or buttons. A close that arrives while a page is still opening
wins: nothing is created. A page lives as long as the window that opened it; when that window closes, or its
screen reloads or crashes, its views are closed.

- It is served from `namzu-ext://x<hash of the extension id>/...`, with its own **in-memory** session
  per page, so two extensions are two origins, two pages of one extension have separate network and
  content rules (a page without a network never inherits the hosts of a page that has one), and
  nothing a page stores survives its window. WebRTC is held to proxied traffic on every page, and on a page that declared no network the peer-connection constructors are removed from the page before any of its script runs, so it cannot make one.
  A file is served only if it is in the list the engine returned for the verified version, under `ui/`,
  resolves inside the version folder, is a regular file and hashes to the signed value at read time.
  A path with `..`, an encoded dot or slash, a backslash, a drive letter or a link is a 404; a file that
  changed after signing is a 500, the page closes and `ui-file-changed` is audited.
- Web preferences are written out for every view: sandbox on, an isolated world, no Node (also in
  workers and frames), web security on, no webview, no plugins, no dialogs. Every permission, device and
  screen request is refused. Requests are cancelled except the page's own origin, `data:` and `blob:`
  images, and, for a page with `usesNetwork`, `https://<host>` for the hosts declared `for: ui`.
- The content policy is exact and cannot be loosened: `default-src 'none'`, `script-src 'self'`, no
  inline script, no `eval`, no remote script or font, no frame, worker, object or form post, and
  `connect-src 'self'` plus the declared hosts. Navigation stays on the page's own origin; windows,
  downloads and webviews are refused; a crashed page is closed and marked stopped, never reloaded in a loop.
- The only script with any privilege is Namzu's own preload. It gives the page one frozen object,
  `namzu`: `namzu.call(method, params)`, `namzu.on(event, handler)`, `namzu.off`, `namzu.version`. The
  user-activation stamp is read there, so a page cannot forge a click. A page also gets Namzu's tokens as
  CSS variables (`--ns-bg`, `--ns-surface`, `--ns-fg`, `--ns-muted`, `--ns-border`, `--ns-font`,
  `--ns-radius`, and its own `--ns-accent`) and may ignore them.
- A call passes the **bridge gate** in the main process: the sender must be a registered extension view,
  the message must come from its main frame, and the frame's origin must be that extension's own; the
  extension a call goes to is the one registered for the sender, never one the message names. Only the
  methods the manifest declares exist (`query:<id>`, `action:<id>`, and the host helpers it listed).
  A message is at most 64 KiB, an answer at most the method's declared size, at most 4 calls are in flight,
  20 a second with a burst of 40, and three malformed messages close the page. An error is one of nine codes
  with a fixed Namzu sentence; text from the extension never reaches the page as an error. A page cannot
  call another extension, Namzu's own methods, the engine, the file system, a shell, the clipboard, a window
  or a URL.

Not done here: the extension's icon file is not yet drawn as an image (the rail shows an initial and the
accent dot, the list a neutral tile), the `panel` slot is declared and served but has no place in the window yet, and a page cannot
open an external link. None of this has been run in a real window; the logic is proved without Electron.
