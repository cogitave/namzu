---
'@namzu/cli': major
---

The terminal now installs a newer Namzu in the background by default. About ten seconds after it starts, and every thirty minutes while it stays open, it looks for a newer version; where Namzu owns the install (an npm or pnpm global install in a folder it can write to, including the installer's `~/.namzu` folder) it installs the new version without asking and says once, in the footer, `Updated to X, restart to use it`. The window you are in keeps running the version it started with. Before this release the terminal only told you a newer version existed. A source checkout, `npx` and the copy inside the Desktop app are never touched, and CI does not install unless you ask.

To keep the old behaviour (a footer line that tells you, no install), set `updates: { auto: false }` in `~/.namzu/config.yaml` or `NAMZU_AUTO_UPDATE=0`. To stop looking altogether, set `updates: { check: false }` or `NAMZU_UPDATE_CHECK=0`. To follow the slower `stable` tag, set `updates: { channel: stable }` or `NAMZU_UPDATE_CHANNEL=stable`. A project config file can only turn these off, never on.

An update takes a lock so two windows never install at once, refuses a version the registry gave no checksum for, runs no install scripts, repairs an update that was interrupted on the next start, keeps the replaced version under `~/.namzu/updates/previous`, starts the new copy once to check it answers, and puts the old version back if anything fails. `namzu upgrade` now uses the same steps, follows the configured channel, also updates pnpm global installs, and says when another update is already running.
