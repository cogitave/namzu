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

1. One update at a time: a lock under `updates/` keeps two Namzu processes from
   installing together. A second one waits quietly and tries again later. A lock
   whose process is gone, or that is older than fifteen minutes, is taken over.
2. The registry must give a checksum for the version. Without one nothing is
   installed. The package manager checks the download against the checksum the
   registry gives it; Namzu does not compare it a second time. Install scripts
   of the package and its dependencies do not run in the background (`--ignore-scripts`).
3. A copy of the version being replaced is kept first (`updates/previous/<version>`,
   the two newest are kept).
4. The installed version is read back, and the new copy is started once and must
   answer with the version it should be.
5. Before the folder is touched, `updates/in-progress.json` records the version,
   the kept copy and the process. If that process is gone before the update was
   verified (the terminal was closed, the machine lost power), the next start
   reads the installed version back, starts it once, and puts the kept copy back
   when it does not answer. The copy is restored by moving a fresh copy into
   place, so the package is never missing half way.
6. If any step fails the previous copy is put back (pnpm installs the previous
   version again), so a failed update leaves a working Namzu. The outcome of the
   last automatic attempt is kept in `updates/last-result.json` and `namzu upgrade
   --check` says when it did not finish.

On Windows a `node_modules\@namzu\cli` folder is only treated as a global
install when `namzu.cmd` sits beside it (or it is Namzu's own folder); a copy
inside a project is never updated. `namzu upgrade --check` says so when
`channel: stable` is set and no stable release has been published.

If Namzu may not write to its folder, it does not try and shows the command
instead. A refused write is not retried for the rest of that session; other
failures are tried at most three times.

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
the same kept copy and the same start-up check, and shows progress. It follows the
configured channel. `namzu upgrade --check` reports what is available without
changing anything. It also updates pnpm global installs; it refuses a layout it
does not recognise instead of guessing.

## Known limits

- Replacing the package while a window is open can break something that window
  loads later; restart the window after an update.
- A Windows copy that is running can be locked by the system. The update then
  fails quietly, keeps the old version and is tried again at the next look.
- Homebrew, winget, scoop and distro packages do not exist for Namzu today.
