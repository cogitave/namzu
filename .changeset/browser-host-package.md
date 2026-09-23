---
'@namzu/browser': minor
---

First release of `@namzu/browser`: a browser engine for the SDK's `browser` and `browser_act` tools.

`PlaywrightBrowserHost` implements `BrowserHost`. Pass it to `createBrowserTools(host)`. It runs an installed Google Chrome, or Playwright's Chromium if Chrome is missing. The browser uses a persistent profile under `NAMZU_HOME/browser/profiles/<name>`, so a site you signed in to once stays signed in. Nothing launches until the first call.

Whatever the permission gate allowed, the host also enforces the following:

- A `browser_act` call's `origin` must equal the live page's origin.
- A navigation, redirect or popup may only land on a site the `sites` rules allow at `read` or `act`, or on one the caller asked to open. A top-level request anywhere else is stopped before it is sent. A redirect is caught when it lands and cleared to `about:blank`.
- A sign-in, a second factor, a CAPTCHA, a bot check or an HTTP 401/407 response stops the call with `browser_human_required`. The error carries the profile and a `namzu browser login <profile> <url>` command.
- Nothing is typed into a password or one-time-code field, and snapshots never show their values.
- Invisible text is left out of snapshots.
- Downloads are cancelled and reported.

`detectBrowserEnvironment(env, platform, probes, options)` works out where the browser runs and whether its window shows, without launching anything. Inside WSL with a Windows Chrome or Edge it returns a `windows-cdp` plan, which this release cannot run. `runnableBrowserPlan` then falls back to Chromium inside WSL, with a warning. Also exported: `BrowserProfileStore`, `BrowserLeaseStore`, `BrowserSitePolicy`, `classifyHumanRequired`, `BrowserUnavailableError`, `ProfileBusyError`, and the SDK's refusal shapes as classes.

`playwright-core` is pinned exactly at 1.63.0, whose Chromium is build 1243. Install that browser with `npx playwright-core@1.63.0 install chromium`, unless Google Chrome is installed. Requires `@namzu/sdk` 44.4.0 or later, the first version with the browser tool contract.

See `docs/sdk/browser-host.md`.
