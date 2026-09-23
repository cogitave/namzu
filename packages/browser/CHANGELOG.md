# @namzu/browser

## 0.1.0

### Minor Changes

- 2b96136: First release of `@namzu/browser`: a browser engine for the SDK's `browser` and `browser_act` tools.

  `PlaywrightBrowserHost` implements `BrowserHost`. Pass it to `createBrowserTools(host)`. It runs an installed Google Chrome, or Playwright's Chromium if Chrome is missing. The browser uses a persistent profile under `NAMZU_HOME/browser/profiles/<name>`, so a site you signed in to once stays signed in. Nothing launches until the first call.

  Whatever the permission gate allowed, the host also enforces the following:

  - A `browser_act` call's `origin` must equal the live page's origin.
  - A navigation, redirect or popup may only land on a site the `sites` rules allow at `read` or `act`, or on one the caller asked to open. A top-level request anywhere else is stopped before it is sent. A redirect is caught when it lands and cleared to `about:blank`.
  - A sign-in, a second factor, a CAPTCHA, a bot check or an HTTP 401/407 response stops the call with `browser_human_required`. The error carries the profile and a `namzu browser login <profile> <url>` command.
  - Nothing is typed into a password or one-time-code field, and snapshots never show their values.
  - Invisible text is left out of snapshots.
  - Downloads are cancelled and reported.

  `detectBrowserEnvironment(env, platform, probes, options)` works out where the browser runs and whether its window shows, without launching anything.

  Inside WSL, with interop on and Chrome or Edge installed on Windows, the host drives the Windows browser (`windows-cdp`) and needs nothing installed on Windows. It starts `powershell.exe` through interop with a bridge script that starts the browser on a dedicated profile under `%LOCALAPPDATA%\namzu\browser\profiles\<name>` (or attaches to it when it is already running) and relays CDP over its standard streams, because WSL's NAT networking cannot reach Windows' `127.0.0.1`. Playwright connects to a relay on WSL's `127.0.0.1` at a random 64-hex-digit path. Under mirrored networking the host tries the browser's port directly first. Every namzu process on a profile shares one browser, and the last one to finish closes it. If namzu dies, the bridge closes the browser it started, and never one it did not. A systemd service without `WSL_INTEROP` gets a socket from `/run/WSL`. Pass `windowsBrowser: 'msedge'` to detection for Edge. Host option `windowsLaunchTimeoutMs` bounds starting the Windows browser. WSL helpers exported: `windowsPathToWsl`, `wslPathToWindows`, `wslNetworkingMode`, `wslInteropSocket`, `findWslInteropSocket`, `parseDevToolsActivePort`, `bridgeArguments`, `encodePowerShellCommand`, `WindowsBridgeError` and their neighbours. Adds a dependency on `ws`.

  Also exported: `BrowserProfileStore`, `BrowserLeaseStore`, `BrowserSitePolicy`, `classifyHumanRequired`, `BrowserUnavailableError`, `ProfileBusyError`, and the SDK's refusal shapes as classes.

  `playwright-core` is pinned exactly at 1.63.0, whose Chromium is build 1243. Install that browser with `npx playwright-core@1.63.0 install chromium`, unless Google Chrome is installed. Requires `@namzu/sdk` 44.4.0 or later, the first version with the browser tool contract.

  See `docs/sdk/browser-host.md`.

### Patch Changes

- 2b96136: `back`, `forward` and `reload` return once the page is back. They waited for `domcontentloaded`, which a page restored from the back-forward cache never fires, so going back in the Windows browser from WSL took 30 seconds and then failed although the page had already returned. They now wait for the navigation to commit, then up to 5 seconds for the document. A move the back-forward cache answered no longer says there is no page to go back to.
