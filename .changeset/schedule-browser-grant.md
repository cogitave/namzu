---
'@namzu/cli': minor
---

Scheduled jobs can drive the browser, on the sites you list and no others.

- **New flags** on `namzu schedule add` and `edit`: `--browser <profile>`, `--browser-site <site>=read|ask|act` (repeatable) and `--browser-headed`; on `edit`, `<site>=none` takes a site off and `--no-browser` removes the grant. Sign in first with `namzu browser login <profile> <url>`. `*` is refused: every site not listed is denied. `ask` needs `--unmatched park`. A browser grant alone (no `--permissions`) needs `--unmatched`.
- **New job field** `permissions.browser` (`profile`, `sites`, `headed`), covered by the confirmation. The model's `schedule` tool in the TUI can now propose it; you confirm it on screen.
- **A job's `[permissions]` rules may no longer name `browser` or `browser_act`**; creating or editing such a job is refused with a pointer to the grant. Without a grant both tools are denied in a scheduled run, as before.
- **A run with a grant checks its browser before the model**: the profile exists and has its data, the browser it was signed in with can start (WSL interop for the Windows browser), a display for `--browser-headed`. Otherwise it is `blocked-config` with the `namzu browser login` command.
- **A run a page parked for you** (a sign-in, a CAPTCHA) reads `needs you: <reason>` in `schedule list`, `show`, `status`, `/schedule` and the TUI's startup line instead of "waiting for approval". `--json` gains `activeRun.handoff` (`list`) and `awaitingApproval[].handoff` and `waitingFor` (`status`).
- The scheduled-run floor also refuses tool arguments naming the Windows browser's profile folder (`…/AppData/Local/namzu`, `%LOCALAPPDATA%\namzu`). A site a config file's `browser.sites` denies stays denied for every job.
- `DISPLAY`, `WAYLAND_DISPLAY` and `XAUTHORITY` now reach a scheduled run's environment.

See docs/cli/scheduled-tasks.md#browser-access.
