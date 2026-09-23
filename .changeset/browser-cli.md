---
'@namzu/cli': minor
---

The interactive terminal can drive a web browser. `@namzu/browser` is now a dependency, and the TUI mounts the `browser` and `browser_act` tools on a namzu-owned profile; in WSL they drive the Windows Chrome. Nothing launches until the model's first browser call. `namzu exec`, `exec --json`, `drain`, `acp` and the resident step do not get the tools.

What changes for you:

- **Browser calls are reviewed by default.** With no config, opening any site and every action on a page is reviewed (`"*": ask`); looking at the page the browser holds is not. Set `browser.sites` to allow sites (`read`, `act`) or refuse them (`deny`), or `browser.enabled: false` to turn the tools off.
- **New config key `browser`** (`enabled`, `defaultProfile`, `engine`, `headless`, `sites`, `keepOpen`). An unreadable site key or level stops namzu from starting and names the key. The key is merged across files per site; a deny in any file holds. A project file that sets `browser.defaultProfile` is refused, and namzu will not start in that folder until the key is removed.
- **Site rules come before your `[permissions]` table for the browser tools.** A table `deny` for `browser` or `browser_act` still wins; a table `allow` or `ask` for them applies only to `back`, `forward` and `reload`.
- **New commands:** `namzu browser login <profile> [url]`, `list`, `status`, `install`, `remove`; the `/browser` slash command (status, `profile <name>`).
- **`namzu doctor`** reports `browser.installed` and `browser.engine`. The boot capability line gains `browser yes|no`.
- **The review screen** names the site rule, profile and engine for a browser call. A turn paused because a page needs you (sign-in, CAPTCHA) says where to do it and how to continue.
- New exports: `browserInstalledCheck`, `browserEngineCheck`; `NAMZU_OPTIONAL_CAPABILITIES` includes `@namzu/browser`.

See docs/cli/browser.md.
