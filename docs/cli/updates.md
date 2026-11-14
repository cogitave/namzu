---
type: Reference
title: Updates
description: How the terminal keeps Namzu up to date in the background, which installs it updates by itself, the updates config keys and environment variables, how a failed update leaves the old version working, and how namzu upgrade shares the same code.
resource: packages/cli/src/integrations/auto-update
tags: [cli, updates, installation, config]
status: stable
generated: { by: process:agent, at: 2026-10-27T00:00:00Z }
---

# Updates

The terminal looks for a newer Namzu while it is open and, where Namzu may,
installs it for you. On an `npm install --global` copy (and the installer's own
`~/.namzu` folder) on macOS and Linux the install happens at once, while you keep
working: the footer shows a dim `Updating to 41.3.0…` and then a green check, and
nothing is restarted:

```text
✓ Updated to 41.3.0 · restart to use it
```

The window you are in keeps the version it started with; the next `namzu` you start is
the new one. Another window open from the same install shows the same line (on its
next look, within a minute if it met the install running, otherwise within thirty).
Where Namzu cannot swap the folder safely (Windows, pnpm, a prefix on another
filesystem), it does not install under an open window: the footer says so quietly and
the install happens when the last Namzu window from that install has closed:

```text
Update 41.3.0 ready · installs when Namzu closes
```

If someone else (you in another terminal, a package manager) puts a newer version on
the disk while a window is open, that window shows the same green check.

## How an install happens under an open window

Namzu is a tree of small files named after a hash of their content
(`dist/chunks/name-HASH.js`), and a window loads some of them only when it first needs
them. So the new version is never installed into the folder a window runs from:

1. The verified download is installed by `npm` into a side prefix next to the live one
   (`.namzu-stage-<pid>` inside the prefix, so on the same filesystem), and its package
   folder is moved beside the live folder (`.cli-next-<pid>`).
2. That new folder is started once (`--version` and `--start-check`). If it does not
   answer, the live folder was never touched and the attempt is recorded as a failed
   version, as before.
3. Every chunk the live folder has and the new one lacks is carried into the new folder
   (a hard link, a copy where links are not possible), and the carried names are listed
   in `dist/.carried-chunks.json`. A chunk's name carries a hash of its content, so an old
   and a new file never share a name unless they are the same file. What was carried
   before is carried again, so a window left open across two updates keeps its files.
4. The two folders trade places with two renames, one right after the other: the live
   folder goes aside (`.cli-aside-<pid>`) and the new one takes its place. A window that
   was open keeps loading its own chunks from the same path; a new start runs the new
   version. The launcher `npm` wrote and `npm ls --global` still point at the same path
   and read the new version.
5. The folder in place is started once more. If it does not answer, the folders trade
   back and the previous version is as it was. The aside folder is removed, the two
   newest kept copies stay (`updates/previous`), and the interrupted-update repair covers
   a crash in between.
6. The carried chunks stay as long as a window of an older version is running from the
   install (each window records its version under `updates/running/`); the first start
   after the last such window ended removes them, and any `.cli-*` or `.namzu-stage-*`
   folder of a process that is gone.

`namzu doctor` run in a window that is still on the old version says `Namzu 41.3.0 is
installed; this window runs 41.2.0` with `Restart Namzu to use it`, not that an update is
available.

Two things stay true of this. For about 15 microseconds (measured, median; at most 26)
between the two renames the path does not exist, and a window that loads a file for the
first time in exactly that moment gets the one plain line described below instead of a
crash; in a loop that loads a file continuously, 7 swaps in 20 hit it, a window that
loads one now and then essentially never. And a window that was started with updates
switched off writes no running record, so the carried chunks do not wait for it.

## What happens to a window that is already open

Namzu is split into many small files, and a window loads some of them only when it
first needs them. Replacing the installed copy while a window runs would take those
files away, and the window would fail the next time it needed one (opening a rarely
used screen, or closing, which used to end in a stack trace and exit code 1 after the
line telling you how to resume). So:

- **Where Namzu cannot swap the folder, its own update waits.** (This is the rest of the
  list: on Windows, for pnpm, for a prefix on another filesystem or one whose chunks are
  not content-hashed.) A window never installs a version over itself. When it
  finds one, it asks for the install to happen after it ends, whichever way it ends
  (closing it, `/exit`, the terminal window going away). A small background process
  (`namzu --apply-at-exit`, it prints nothing) then waits until no Namzu process runs
  from that install any more, so a second window that is still open is never replaced
  under, and installs with the checks described below. Each process that runs a turn
  (the terminal, `namzu exec`, the scheduler's runs) leaves one small file under
  `updates/running/` in the install's `.namzu-update` folder while it runs; a file whose
  process is gone is ignored and removed when the next window starts. With updates switched
off (`updates.check` false or `NAMZU_UPDATE_CHECK=0`) a window writes nothing into the
install. When the terminal window itself goes away (hang-up) or the process is asked to stop
(terminate), the installer is started and the file removed before the process ends; a process
that is killed outright (`SIGKILL`, power loss) starts nothing, and the next window that
ends starts it. Short commands (`--version`, `doctor`, `upgrade`) and `namzu acp` leave
  none. The background process gives up after six hours and leaves the update for the
  next window to close. The cost: the update lands when you stop, not ten seconds after
  you start.
- **An install by someone else can still remove files** from a window that is open
  (`npm install --global` in another terminal, `namzu upgrade`, a package manager).
  `namzu upgrade` says when other windows are open from the install it just replaced.
  A window that needs a file that is gone says one plain line, never a stack trace:
  `Namzu 41.3.0 was installed while this window was open, so part of Namzu 41.2.0 is no
  longer on disk and this could not be done. Your conversation is saved; start Namzu
  again to continue it.` It says that only when the version on disk really differs from
  the one running and the missing file is Namzu's own, whether a file or a whole package is
  gone. Closing such a window works: the
  way out loads nothing from disk. The conversation is written as it goes, so nothing is
  lost, and `namzu resume` continues it with the new version.
- **The Desktop app's engines** live in one folder per version and are never replaced in
  place, so a running engine keeps all its files; the copy inside the installer moves
  only with the app.

For each kind of install:

| Install | A window that is open when a newer version arrives |
|---|---|
| `npm install --global`, and the installer's `~/.namzu` folder, updated by Namzu (macOS, Linux) | Keeps working: the install is swapped in at once and the window keeps its files. |
| The same on Windows; `pnpm add --global`, updated by Namzu | Keeps working: the install waits for the last window. |
| Any of the above, upgraded by you or another tool meanwhile | May lack files it has not loaded yet; says the plain line above and is saved. |
| A source checkout, `npx`, the Desktop app's copy | Never replaced by Namzu. |

## When it looks

- About ten seconds after the terminal starts (never delaying the first screen),
  then every thirty minutes while it stays open.
- Two Namzu windows share one look: whichever looked last wrote the answer under
  `updates/` in your Namzu home, and another window within five minutes reuses it.
- Only the interactive terminal does this. `namzu exec`, `run`, `acp`, the
  scheduler and every other command never update by themselves.
- Offline, a slow registry or an odd answer is silent and tried again at the next
  look.

## What it updates by itself

Namzu works out how this copy was installed from where it runs. It never guesses
a package manager and never replaces a copy it does not own.

| Install | What happens |
|---|---|
| `npm install --global` (including the installer's own `~/.namzu` folder) | Installed at once under open windows on macOS and Linux, and after the last window closes on Windows, when Namzu may write to the folder; otherwise the footer shows the exact command to run (`sudo npm install --global --prefix … @namzu/cli@X`). |
| `pnpm add --global` | Installed the same way when its global folder is writable (macOS, Linux, WSL); otherwise the footer shows `pnpm add --global @namzu/cli@X`. |
| A source checkout, `npx` / `pnpm dlx`, the copy inside the Desktop app | Never touched and never announced. The Desktop app updates its own copy. |
| Any other layout | The footer says a newer version exists and to reinstall; nothing is changed. |

In CI the terminal still looks, but it does not install unless you ask for it
(see below).

## How an update stays safe

1. One update at a time per install: a lock kept inside the install itself
   (`.namzu-update/updates/locks/` under the npm prefix or pnpm's global folder,
   which must be writable for an update to run at all) keeps two Namzu processes
   from changing the same install together, whatever their Namzu home or user, while two different
   installs (two npm prefixes, or npm and pnpm) never wait on each other. A second
   process waits quietly and tries again later. The `.namzu-update` folder stays in
   the prefix after an update (it holds only small lock and marker files); delete it
   when you uninstall Namzu. A lock whose process is gone, or
   that is older than fifteen minutes, is taken over, and taking it over is
   atomic: when two processes both find the same stale lock, exactly one of them
   gets it.
2. The registry must give a checksum and an address for the version. Namzu
   downloads that file itself, from the registry it asked, and compares its
   sha512 with the registry's digest before anything on your disk is touched. A
   download that is interrupted, comes from another address, or does not match is
   thrown away and nothing is installed. The package manager is then handed that
   verified file, not a version name, so a registry setting on your machine
   cannot change which files get installed (the `@namzu` scope is pinned to the
   registry the release came from; the package's own dependencies still follow
   your package manager's settings). The package manager runs the package's own
   install steps, as `npm install --global` does for you, so the optional
   terminal-session module is built again for the new version. It runs in its own
   process group with its output going to a log file
   (`updates/install-<install>.log`), not to a pipe, so closing the terminal
   does not stop it half way; its process id is kept in the marker below, and the
   end of the log is kept with the last result.
3. A copy of the version being replaced is kept first
   (`.namzu-update/updates/previous/<install>/<version>` inside the install, the two newest are kept; in the install so that a process with another Namzu home can put it back).
   The copy, and putting it back, run asynchronously, so the terminal keeps
   answering while thousands of files are copied (on Windows, where each is
   scanned as it is written, that takes seconds).
4. The installed version is read back, and the new copy is started and must
   answer with the version it should be and then load what a terminal session
   needs when it starts: the terminal interface, the runtime under it, and the
   terminal-session module where one is installed (`namzu --start-check`, which
   prints `ok` and starts nothing). A release with a missing file or a native
   module that will not load is rolled back here, not found by the next person who
   opens Namzu.
5. Before the folder is touched, `.namzu-update/updates/in-progress-<install>.json`
   (in the same place as the lock, so every home sees it) records the
   version, the kept copy and the process. If that process is gone before the
   update was verified (the terminal was closed, the machine lost power), the next
   start reads the installed version back, starts it, and puts the kept copy back
   when it does not answer. A marker older than fifteen minutes is treated as
   dead, a marker whose installer still runs is left alone, and only a copy under
   `updates/previous` in the install's `.namzu-update` folder is ever put back. With installing switched off, nothing is
   repaired or rewritten. The copy is restored by moving a fresh copy into
   place, so the package is never missing half way.
   For pnpm the verified file is followed by `pnpm add --global --offline
   @namzu/cli@<version>` (with the `@namzu` scope pinned to the same registry), which
   links the bytes already in pnpm's store and never fetches, so its global manifest
   names a registry version and not a path to a file that no longer exists (pnpm would
   otherwise skip Namzu in `pnpm update --global`) and what is installed is the
   checked file. When the store cannot serve it the update stands and the file entry
   stays; `namzu upgrade` says so and names the one command that switches it.
   `namzu upgrade` runs these same steps, writes the same marker, and puts the
   previous version back the same way (offline from the store first, and it must start).
6. If any step fails the previous copy is put back (pnpm installs the previous
   version again, offline from its store first and from the registry only if the
   store lacks it, and the result must start), so a failed update leaves a working Namzu. The outcome of the
   last automatic attempt is kept per install in `updates/last-result-<install>.json` and `namzu upgrade
   --check` says when that attempt did not finish, and where the installer's log is,
   only when it was for the version now offered.

## When a version did not work

If Namzu may not write to its folder, it does not try. The footer says
`Update available, can't install here. See namzu doctor`, short enough to read
whole at any width, and `namzu doctor` shows the reason, the folder and the full
command (`sudo npm install --global --prefix … @namzu/cli@X`; on Windows the same
command without `sudo`).

The version, the reason and the time of a failed attempt are kept in
`updates/attempt-<install>.json` (one per install, so another install's failure does not hide an update here). Every later start, and every window open at the time,
skips that version instead of swapping the package folder for it again under
windows that are still open. It is tried again when a newer version is published.
Two kinds of failure are different because they say nothing about the version: an
interrupted download, a file in use by another program and a full disk are tried
again after six hours, and the footer says `Couldn't update Namzu on its own. Run:
<command>` once for them.

For a version that failed for any other reason (it did not start, did not match its
checksum, the installer did not finish) the footer says once `Namzu X could not
start here; staying on Y` (or `could not be installed`) and offers nothing for that
version: the command would fail the same way. `namzu doctor` keeps saying so, with
the log of the attempt, until a newer version is published.
`namzu upgrade --check` says the same for a version that did not start: it is available,
it did not start here last time, the previous version was put back, and where the
installer's log is; it does not suggest installing it. `namzu upgrade` itself still
tries it when you run it.

`namzu upgrade` keeps the installer's own output out of the way: nothing of it is
shown on success, and after a failure it follows the error under `Details:`.

On Windows a `node_modules\@namzu\cli` folder is only treated as a global
install when `namzu.cmd` sits beside it (or it is Namzu's own folder); a copy
inside a project is never updated. `namzu upgrade --check` says so when
`channel: stable` is set and no stable release has been published.

pnpm global installs are recognised in the layouts pnpm has used: the store
inside `…/pnpm/global/<n>/.pnpm`, the store under `…/pnpm/global/<n>/node_modules/.pnpm`
(older pnpm) and the link `…/pnpm/global/<n>/node_modules/@namzu/cli`.

A window that was already open keeps running the code it started with. Restart it
to use the new version. The record of the last automatic attempt (`last-result-<install>.json`,
`namzu upgrade --check`, `namzu doctor`) is written by the background process that did the
install, so it is there for the next window to read.

## Settings

In your own config file (`$NAMZU_HOME/config.yaml`):

```yaml
updates:
  auto: true       # install in the background (default: on at a terminal, off in CI)
  channel: stable  # latest (default) or stable
  check: true      # false stops looking and hides the footer line
```

| Key | Environment | Meaning |
|---|---|---|
| `updates.auto` | `NAMZU_AUTO_UPDATE` (`0`/`off` or `1`/`on`) | Install without being asked. `false` leaves only the footer line with the command. `true` asks for it even in CI. The variable wins over the file. |
| `updates.channel` | `NAMZU_UPDATE_CHANNEL` (`latest` or `stable`) | Which release tag to follow. `stable` follows the `stable` tag, which is moved by hand and may lag `latest`. Namzu never installs an older version than the one running. |
| `updates.check` | `NAMZU_UPDATE_CHECK` (`0`/`off`) | `false` stops the background look altogether: no network, no footer line. `namzu upgrade` still works. |

A project config file can only turn `auto` and `check` off for its own runs; it
cannot turn installing on or pick a channel.

## `namzu upgrade`

`namzu upgrade` runs the same code once, in the foreground, with the same lock,
the same checked download, the same kept copy and the same start check, and shows
progress. It ignores a version the background update gave up on: asking for it
is a request to try again. It follows the
configured channel. `namzu upgrade --check` reports what is available without
changing anything. It also updates pnpm global installs; it refuses a layout it
does not recognise instead of guessing.

## Known limits

- Namzu's own swap keeps a window's chunk files, but an install made by you or
  another tool can remove them: that window says one plain line when it needs a file that
  is gone (see above) and is restarted to continue. A window left open across a swap also
  reads the new version's copy of a dependency under `node_modules` (not the one it
  started with); if that dependency changed incompatibly, the same line appears. Disk
  grows by the carried chunks (about the size of `dist/chunks`) until the last older window
  ends. Where the install waits for the last window (Windows, pnpm), it is later than one
  installed at once; a window left open for days postpones it (the update is installed at
  the end of the next window that closes alone).
- A Windows copy that is running can be locked by the system. The update then
  fails quietly, keeps the old version and is tried again after six hours.
- Homebrew, winget, scoop and distro packages do not exist for Namzu today.
- TODO: the look at the registry and the download do not follow a proxy
  configured in the environment (`HTTPS_PROXY`, `NO_PROXY`) yet; behind a proxy
  that blocks direct connections the terminal stays silent and `namzu upgrade`
  reports that it could not check. The package manager it starts does follow
  your own proxy settings. Proxy support for the CLI's network calls lands
  separately, and these two calls should use it when it does.
