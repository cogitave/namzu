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
installs it in the background. Nothing is shown while it works. When an update
was installed, the right end of the footer says so once:

```text
Updated to 41.3.0, restart to use it
```

The running conversation is never restarted or interrupted; the next `namzu` you
start is the new version.

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
| `npm install --global` (including the installer's own `~/.namzu` folder) | Installed in the background when Namzu may write to the folder; otherwise the footer shows the exact command to run (`sudo npm install --global --prefix … @namzu/cli@X`). |
| `pnpm add --global` | Installed in the background when its global folder is writable (macOS, Linux, WSL); otherwise the footer shows `pnpm add --global @namzu/cli@X`. |
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
to use the new version.

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

- Replacing the package while a window is open can break something that window
  loads later; restart the window after an update.
- A Windows copy that is running can be locked by the system. The update then
  fails quietly, keeps the old version and is tried again after six hours.
- Homebrew, winget, scoop and distro packages do not exist for Namzu today.
- TODO: the look at the registry and the download do not follow a proxy
  configured in the environment (`HTTPS_PROXY`, `NO_PROXY`) yet; behind a proxy
  that blocks direct connections the terminal stays silent and `namzu upgrade`
  reports that it could not check. The package manager it starts does follow
  your own proxy settings. Proxy support for the CLI's network calls lands
  separately, and these two calls should use it when it does.
