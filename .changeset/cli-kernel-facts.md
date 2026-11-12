---
'@namzu/cli': minor
---

`namzu acp` now says its own version in the `initialize` answer (`kernel.commandLine`), and `namzu acp --desktop` also says `kernel.desktopContract`, a new exported integer constant (`DESKTOP_CONTRACT`, starting at 1) that an installed Namzu Desktop checks before it runs a newer command line it fetched itself. Existing readers ignore the new field. A copy of the command line that the desktop app keeps in its own data folder (`<app data>/kernel/versions/<version>`) is now recognised by its location as the app's own and is never updated by the terminal's background updater, whether or not it runs under the app's program. A test records everything the desktop app relies on in `packages/cli/desktop-contract/inventory.json` and fails when a method, notification, flag or mirrored shape it names disappears or changes.
