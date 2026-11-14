---
"@namzu/cli": minor
---

An update of an `npm install --global` copy (and of the installer's own `~/.namzu` folder) on macOS and Linux now installs while Namzu windows are open, instead of waiting for the last one to close. You see a dim `Updating to X…` in the footer, then `✓ Updated to X · restart to use it`; the window you are in keeps working and keeps the version it started with, and the next `namzu` you start is the new version. A window started before this release still waits as before.

How it is done: the new version is installed beside the old folder, started once, given the lazily loaded files of the old one, and then the two folders trade places; if the new folder does not start, nothing changed. Between the two renames the folder is absent for about 15 microseconds, and a window that loads a file for the first time in exactly then shows the existing "installed while this window was open" line instead of a crash.

No setting, flag or default changes: `updates.auto` and `NAMZU_AUTO_UPDATE=0` still turn installing off (the footer then only offers the command), `updates.check` and `NAMZU_UPDATE_CHECK=0` still turn the look off. This is why the bump is minor, not major. What does change is when an automatic install happens; there is no setting to restore the install-after-close timing on these installs, and Windows, pnpm global installs and a prefix on another filesystem keep it. `namzu doctor` in a window that is still on the old version now says the new version is installed and a restart is left.

A window with updates switched off now also writes its small running record under the install, so another window's update keeps the files it still needs; it still checks, downloads and installs nothing.
