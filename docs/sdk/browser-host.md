---
type: Reference
title: The browser host
description: "@namzu/browser's PlaywrightBrowserHost: engine detection, the Windows browser driven from WSL through a PowerShell bridge, profiles and leases, the site policy checked after every navigation, the human-handoff classifier, snapshot refs and filtering, and what it refuses."
resource: packages/browser/src/host.ts
tags: [browser, host, playwright, permissions, profiles]
status: draft
generated: { by: human:bahadirarda, at: 2026-09-23T00:00:00Z }
---

# The browser host

`@namzu/browser` is the engine behind the SDK's [browser tools](browser-tools.md). `PlaywrightBrowserHost` implements `BrowserHost` with Playwright, on a persistent browser profile, in the calling process. The SDK never imports it; a host application such as the CLI constructs it and passes it to `createBrowserTools(host)`.

```ts
import { PlaywrightBrowserHost } from '@namzu/browser'
import { ToolRegistry, createBrowserTools } from '@namzu/sdk'

const host = new PlaywrightBrowserHost({
  profile: 'work',
  mode: 'interactive',
  headless: 'auto',
  sites: { 'https://github.com': 'act', '*': 'ask' },
})

const registry = new ToolRegistry()
for (const tool of createBrowserTools(host)) registry.register(tool)
```

The constructor launches nothing and touches no file. The first `observe` or `act` creates the profile if needed, takes a lease on it, and launches the browser. `dispose()` releases the lease and closes the browser unless `keepOpen` was set; `close()` closes it regardless.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `profile` | `default` | The profile to run under. The operator chooses it, never the model. |
| `home` | `NAMZU_HOME`, resolved at first launch | Where profiles and leases live. |
| `sessionId` | random | Names this host's lease. |
| `plan` | `detectBrowserEnvironment(env, platform)` | The engine plan; see below. |
| `engine`, `headless`, `mode` | `auto`, `auto`, `interactive` | Passed to detection when `plan` is absent. |
| `sites` | `{ '*': 'ask' }` | Site rules for the checks after the fact. |
| `keepOpen` | `false` | Leave the browser running after `dispose()`. For the Windows engine, also when this process dies. |
| `navigationTimeoutMs`, `actionTimeoutMs` | 30 000, 10 000 | Playwright timeouts. |
| `snapshotMaxChars` | 20 000 | Characters per snapshot page; 20 000 is also the ceiling. |
| `executablePath` | the plan's browser | Launch this binary instead. |
| `signInAddresses` | none | More sign-in addresses for the classifier, as `host` or `host/path`. |
| `loginCommand` | `namzu browser login <profile> <url>` | The command a handoff names. |
| `windowsLaunchTimeoutMs` | 60 000 | Windows engine: how long starting the browser and connecting to it may take. |

`host.warnings` repeats detection's warnings; `host.running` says whether the browser is up.

## Where the browser runs

`detectBrowserEnvironment(env, platform, probes, { engine, headless, mode, windowsBrowser })` returns a plan without launching anything. Every file-system question goes through `probes` (`exists`, `readFile`, `listDir`, and optionally `modifiedMs` and `run`), so a test can describe any machine.

| Where | Plan |
| --- | --- |
| WSL2, interop working, Windows Chrome or Edge installed | `windows-cdp`: the Windows browser over CDP |
| WSL2 otherwise | `local` Chromium inside WSL, with a warning naming what was missing |
| Linux | `local`: Google Chrome (channel `chrome`) if `/opt/google/chrome/chrome` exists, else Playwright's Chromium |
| macOS | `local`: Google Chrome if installed, else Playwright's Chromium |
| Windows | `local`: Chrome, else Edge, else Playwright's Chromium |

WSL is recognised from `WSL_DISTRO_NAME`, `WSL_INTEROP` or the kernel release, because a systemd service has neither variable. Interop needs the `WSLInterop` binfmt handler and a socket (`WSL_INTEROP`, or one under `/run/WSL`).

Headless: `always` is headless and `never` is headed; with no display, `never` makes the plan unavailable. `auto` shows a window only when there is a display (`DISPLAY` or `WAYLAND_DISPLAY` on Linux; always on macOS and Windows) and `mode` is `interactive`. A scheduled run passes `unattended` and runs headless.

`runnableBrowserPlan(plan)` returns the plan, or its `fallback` when the plan is unavailable and has one. A plan the host cannot run is reported through `capabilities.unavailableReason`, so both tools stay mounted and refuse every call with it. `engine: 'windows'` outside WSL, or inside WSL without interop, `powershell.exe` or a Windows browser, is such a plan.

## The Windows browser from WSL

Inside WSL, with interop working and Chrome or Edge installed on Windows, the plan is `windows-cdp`: the browser is the Windows one, in the operator's Windows session, and sites see a Windows browser. Chrome is preferred; `windowsBrowser: 'msedge'` asks for Edge (a warning says so when the one asked for is missing and the other is used).

```ts
import { detectBrowserEnvironment } from '@namzu/browser'

const plan = detectBrowserEnvironment(process.env, process.platform)
if (plan.engine === 'windows-cdp') {
  console.log(plan.windowsExecutable, plan.networkingMode, plan.interopSocket ?? 'own WSL_INTEROP')
}
```

The plan carries:

| Field | Meaning |
| --- | --- |
| `executable`, `windowsExecutable` | the browser as WSL sees it (`/mnt/c/Program Files/…/chrome.exe`) and as Windows does (`C:\Program Files\…\chrome.exe`) |
| `powershell` | `powershell.exe` by absolute path under the mount root; `PATH` is never searched |
| `mountRoot` | where the Windows drives are mounted: `[automount] root` of `/etc/wsl.conf`, else `/mnt/` |
| `networkingMode` | `wslinfo --networking-mode`; without `wslinfo`, the one `.wslconfig` under `C:\Users` (`[wsl2] networkingMode`, NAT when unset); else `unknown` |
| `interopSocket` | a socket under `/run/WSL` to hand `powershell.exe` as `WSL_INTEROP`, present only when this process has no working `WSL_INTEROP` of its own (a systemd service): `1_interop`, else the newest |

**Why a bridge.** Chrome 136 and later refuse remote debugging on the default profile, so the browser always runs on a dedicated `--user-data-dir`. Under WSL's default NAT networking, WSL cannot reach Windows' `127.0.0.1`, where the debugging port listens, and a headed Chrome ignores `--remote-debugging-address`. So the host starts `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <script>` through interop (the script is a string constant, about 6 KB, sent as UTF-16LE base64; its parameters are base64 JSON inside it, so nothing is quoted for PowerShell's parser). The script:

1. reads the profile's `DevToolsActivePort`; if the port it names answers, it attaches to that browser;
2. otherwise deletes a stale `DevToolsActivePort` and starts the browser with `--user-data-dir=<profile> --remote-debugging-port=0 --no-first-run --no-default-browser-check` (and `--headless=new --window-size=1280,800` when headless) on `about:blank`, then polls `DevToolsActivePort` for the port the browser chose. A browser that exits first means the profile is open in a window started without remote debugging: `ProfileBusyError`;
3. connects a `ClientWebSocket` to `ws://127.0.0.1:<port>/devtools/browser/<id>` and relays one JSON message per line both ways: a message the browser sends in several frames is assembled before it is written, and a message of many megabytes is one line;
4. exits when its standard input closes or the browser goes away.

On the WSL side the host listens on `127.0.0.1:0` at a path of 32 random bytes in hex, and Playwright's `connectOverCDP` connects there; every message goes through the bridge. Any other path is answered 404 before a WebSocket is made, a request with an `Origin` header (every web page's WebSocket has one) 403, and a second client 409. Under mirrored networking the host first connects straight to the browser's port, and falls back to the relay if that does not answer within 3 seconds; the bridge still runs, because it is what closes the browser if this process dies.

Playwright points a connected browser's downloads at a temporary directory on the WSL side, a path that means something else on Windows. The host refuses downloads in the browser itself (`Browser.setDownloadBehavior` `deny`) and reports each one, as it does for the local engine.

**Profiles.** A Windows-engine profile's user data is on the Windows side, under `%LOCALAPPDATA%\namzu\browser\profiles\<name>`; its descriptor in `NAMZU_HOME` records `engine: 'windows-cdp'`, the browser and that Windows path. A profile made with Chrome is refused to Edge and the other way round, and a local profile's name is refused to the Windows engine. `BrowserProfileStore.remove` deletes the Windows directory through the drive mount, and only when it is a `…\namzu\browser\profiles\<name>` directory.

**Leases and closing.** Leases on a Windows-engine profile are shared: every namzu process on the profile drives the same browser, attaching through `DevToolsActivePort`. `dispose()` of the last holder closes the browser with CDP `Browser.close`, which lets it save the profile; any other holder, or `keepOpen`, disconnects and leaves it running. If this process dies, the bridge's standard input closes and the bridge closes the browser it started (never one it attached to). If the bridge dies instead, the host starts a second bridge that only attaches and sends `Browser.close`. With `keepOpen` neither happens. The bridge stops nothing by name: its last resort, ten seconds after `Browser.close`, is the process id it started.

**Measured** on WSL 2.7.14 (NAT) with Chrome 153, headless, against the same pages with the local engine: first call (start PowerShell and Chrome, navigate) 1.3–3.7 s; a snapshot of example.com 155 ms against 153 ms locally, of a 20 000-character Wikipedia page 296 ms against 289 ms; a viewport screenshot 69 ms against 34 ms; a full-page screenshot of that page (1264×27299, 3.5 MB PNG) 0.97 s through the bridge (the local headless shell took more than the 10-second action timeout).

## Profiles and leases

```text
NAMZU_HOME/browser/
  profiles/<name>.json                 { v: 1, name, engine, userDataDir, browser, createdAt, lastLoginAt? }
  profiles/<name>/                     the browser's user data directory
  leases/<name>/<pid>-<session>.json
```

Profile names are lowercase words joined by single hyphens, at most 64 characters. Every directory is created `0700` and every file `0600`: the user data directory holds the site's cookies. `BrowserProfileStore` lists, creates (`ensureLocal`), marks a sign-in (`markLogin`) and removes profiles; `remove` refuses while any live process holds a lease.

A local profile can be open in one browser at a time. The host takes an exclusive lease before launching; a live lease held by another process, or by another session of this one, is a `ProfileBusyError` naming the holders. A lease whose process has exited is removed on the next look. Chromium's own profile lock, if it trips anyway, is reported as `ProfileBusyError` too.

## The site policy after the fact

The gate decides whether a call may run. The host decides whether the page the browser actually ended up on may stay, and whether the live page may be changed. `BrowserSitePolicy` reads the same site keys as the gate's site rules (`https://github.com`, `https://*.example.com`, `http://localhost:*`, `*`), canonicalised by the SDK's `canonicalizeBrowserSitePattern`. A matching `deny` wins; otherwise the most specific key; otherwise `*`; otherwise `ask`.

| Level | Open | Stay after a redirect or popup | Act |
| --- | --- | --- | --- |
| `deny` | refused, nothing loaded | cleared | refused |
| `read` | yes | yes | refused (`browser_site_denied`) |
| `ask` | yes (the gate reviewed the call) | only if the caller asked for that origin this session | yes (the gate reviewed the call) |
| `act` | yes | yes | yes |

- `navigate` and `tabs new` record their target's origin as asked for.
- Every top-level request (a link, a form, a script moving the tab, a popup's first load) is screened before it is sent. One the policy does not allow is aborted, so its address, and anything a page put into it, never reaches the network; the tab stays on its page and the result says what was blocked.
- A server redirect is not screened by Playwright's routing, so every committed main-frame navigation is checked when it lands. A page that may not stay is cleared to `about:blank` and the result says so.
- Non-web schemes (`file:`, `chrome:`, `data:`), cloud metadata addresses and error pages never stay. A `blob:` document is judged by the origin inside it.
- Before every `browser_act`, the call's `origin` must equal the live page's canonical origin (`browser_origin_mismatch` otherwise), and that origin must be at `ask` or `act`.

Screening every request through Playwright's routing turns off the browser's HTTP cache for the session.

## A person is needed

After every navigation and every action, the host reads the page and `classifyHumanRequired` decides whether it needs a person. All of it is read by the host; nothing the model says reaches the classifier.

| Reason | Signal |
| --- | --- |
| `http-auth` | the main document's last response was 401 or 407 |
| `captcha` | a visible frame (at least 30×30) served from `challenges.cloudflare.com`, `hcaptcha.com`, `arkoselabs.com`, `funcaptcha.com`, `recaptcha.net` or `google.com/recaptcha/`; an invisible-badge frame (`size=invisible`) is not |
| `bot-block` | the title is a known interstitial ("Just a moment...", "Attention Required! \| Cloudflare", "Access denied", …), anchored so a page about access control does not match |
| `two-factor` | a visible one-time-code field, or a second-factor address (`/two-factor`, `/2fa`, `/mfa`, `/otp`, `github.com/sessions/two-factor`) |
| `sign-in` | a visible password field, or a sign-in address (`/login`, `/signin`, `/sign-in`, `/auth`, `/sso`, `/oauth/authorize`, `accounts.google.com`, `login.microsoftonline.com`, `github.com/login`, …, plus `signInAddresses`) |

The call throws `BrowserHumanRequiredError` (`code: 'browser_human_required'`) with the reason, the origin, the profile and `loginCommand` (`namzu browser login <profile> <origin><path>`, query dropped). The SDK tool turns it into a failed result carrying `data.handoff = { kind: 'human-required', reason, detail: { origin, profile, loginCommand } }`. The page is left as it is, so a person at a headed window can finish the sign-in there.

It errs toward stopping: a settings page with a visible password box is read as a sign-in.

**Credential fields.** `type`, `fill_form` and `press` into a field that is `type=password`, has `autocomplete` `current-password`, `new-password` or `one-time-code`, or is named like a one-time code (`otp`, `totp`, `2fa`, `verification code`, …) are refused with reason `credential-field` before anything is typed, whatever the gate allowed. A `fill_form` that includes one fills nothing. `press` without a ref is refused while such a field has focus, except Tab, Shift+Tab, Escape and Enter.

## Snapshots

`snapshot` takes `page.ariaSnapshotJSON({ mode: 'ai', boxes: true })` and renders it one element per line:

```text
- heading "Example Domain" [level=1] [ref=e3]
- paragraph [ref=e4]: This domain is for use in documentation examples without needing permission.
- link "Learn more" [ref=e6]:
  - /url: https://iana.org/domains/example
```

Refs are Playwright's. They stay the same across snapshots for an element that stays, and after a navigation they may carry a frame prefix (`f2e17`). An action resolves a ref with Playwright's `aria-ref=` selector, and only a ref the latest snapshot showed is accepted; anything else is `browser_stale_ref`.

Left out of the text:

- `aria-hidden` subtrees (`display: none` and `visibility: hidden` are already outside the accessibility tree);
- the own text of an element nobody can see: at most 1 pixel wide or high (the "visually hidden" pattern), entirely outside the document, fully transparent (itself or through an ancestor), text smaller than 2 px, or text in a transparent colour. Visible children of such an element are kept.

The value of a password or one-time-code field is shown as `[value hidden: password or one-time code]`: the accessibility tree carries an input's value as its text, and an autofilled profile would otherwise hand the model the password.

The page-reading scripts run in the page's own JavaScript world, so a hostile page can defeat the invisibility filter. It is hygiene; the boundary is the gate, the origin check, the credential refusal and the untrusted envelope the SDK wraps around every snapshot.

A snapshot longer than a page (`snapshotMaxChars`, at most 20 000) is cut at a line boundary and returns `nextCursor`; `snapshot` with that cursor returns the next page. A cursor from an older snapshot is refused. At most 400 000 characters are kept, with a note at the end. `snapshot` with `ref` returns that element's subtree, cut from a whole-page snapshot so the other refs stay valid.

## Tabs, dialogs, downloads

- Tabs are `t1`, `t2`, … A popup becomes a tab the host owns and does not become active; the result says it opened. A popup whose first load the policy stops never opens.
- A `beforeunload` prompt is accepted so the approved navigation proceeds, and the result says so. Any other dialog pauses the page: the result says one is open, a snapshot shows its type and text, every other `browser_act` is refused until `browser_act dialog` answers it, and a navigation dismisses it.
- Downloads are cancelled (`acceptDownloads: false`; the Windows engine refuses them in the browser) and reported by file name.
- `upload` sets a file input directly, or answers the file chooser a click on the element opens.
- `back`, `forward` and `reload` return when the navigation commits, after waiting at most 5 seconds for the document: a page restored from the back-forward cache fires no `domcontentloaded`.

## Errors

| Error | When |
| --- | --- |
| `BrowserUnavailableError` (`browser_unavailable`) | the plan is unavailable, the browser binary is missing (the message names `namzu browser install`), or it could not start |
| `ProfileBusyError` (`browser_profile_busy`) | another holder has the profile |
| `BrowserOriginMismatchError`, `BrowserStaleRefError`, `BrowserHumanRequiredError`, `BrowserSiteDeniedError`, `BrowserOutcomeUnknownError` | the SDK's structural refusals; the tools recognise them by shape |

An action that fails after it started (a click that timed out after the pointer went down, a form half filled) is `browser_outcome_unknown` with `retrySafety: 'unsafe'`. Everything that can refuse — the ref, a credential field, whether the element can be clicked — is checked first, so a refusal means nothing happened.

## The Playwright pin

`playwright-core` is pinned exactly, at `1.63.0` (`PLAYWRIGHT_CORE_VERSION`), whose Chromium is build 1243. The ai-mode snapshot is public API in that version; the `aria-ref=` selector is not documented. A unit test fails when the installed version differs from the constant, and the E2E contract test resolves a ref through the selector, so an upgrade has to pass through both. The fallback, should the selector go, is CDP `Accessibility.getFullAXTree` and `DOM.resolveNode`, behind `src/snapshot.ts`. Two behaviours of this version are relied on: a snapshot of one element replaces the page's ref table, and a snapshot waits forever while a dialog is open.

## Tests

`pnpm --filter @namzu/browser test` runs the unit tests: the classifier over the fixture pages' signals, the policy, detection over injected environments (WSL networking mode, interop socket, mount root, Edge), profiles and leases, snapshot rendering and paging, the pin, the bridge's command-line encoding and line framing (an 8 MB line in odd-sized chunks), the bridge's process protocol against a stand-in, and the relay's refusals. `NAMZU_BROWSER_E2E=1` adds the end-to-end suite, headless, against a local fixture server with two origins (`127.0.0.1` allowed, `localhost` not); it needs the Chromium build in the Playwright cache and downloads nothing. `NAMZU_BROWSER_E2E_HEADED=1` with a display adds a headed run. `NAMZU_BROWSER_WSL_E2E=1` (`pnpm --filter @namzu/browser test:e2e:wsl`) runs the Windows engine on a real WSL machine: the bridge relaying 5 MB and nine-frame messages through PowerShell, headless Chrome through the fixture server (reached through WSL's localhost forwarding), downloads refused, two holders sharing one browser, the bridge killed with and without `keepOpen`, and Edge when installed; `NAMZU_BROWSER_WSL_E2E_HEADED=1` adds a visible window. Its profiles are `namzu-test-e2e-*` and are deleted afterwards.
