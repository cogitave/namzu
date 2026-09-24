<!-- okf
type: Reference
title: "@namzu/browser"
description: >-
  A browser host for the SDK's browser tools: Chromium driven by Playwright on
  a persistent profile (the Windows browser when running in WSL),
  accessibility snapshots with element refs, a site policy checked after
  every navigation, and a stop for anything only a person should do.
tags: [readme, package, browser]
status: draft
generated: { by: human:bahadirarda, at: 2026-09-23T00:00:00Z }
-->

<div align="center">

<h1>@namzu/browser</h1>

**A web browser for Namzu agents.**

[![npm](https://img.shields.io/npm/v/@namzu/browser.svg)](https://www.npmjs.com/package/@namzu/browser)
[![build](https://github.com/cogitave/namzu/actions/workflows/ci.yml/badge.svg)](https://github.com/cogitave/namzu/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)

[Install](#install) · [Usage](#usage) · [WSL](#wsl) · [What it enforces](#what-it-enforces) · [Documentation](#documentation)

</div>

---

`PlaywrightBrowserHost` implements the SDK's `BrowserHost`, so
`createBrowserTools(host)` gives a model the `browser` and `browser_act` tools
over a real browser. It runs Google Chrome when one is installed and
Playwright's Chromium otherwise, on a persistent profile under
`NAMZU_HOME/browser/profiles/<name>`, so a site you signed in to once stays
signed in.

Nothing starts when the host is constructed. The browser is launched by the
first call that needs it.

## Install

```bash
pnpm add @namzu/sdk @namzu/browser
npx playwright-core@1.63.0 install chromium   # unless Google Chrome is installed
```

`@namzu/sdk` is a peer dependency. `playwright-core` is pinned exactly: the
element refs rest on a Playwright selector that is not documented, and the
pin is what keeps them working.

## Usage

```ts
import { PlaywrightBrowserHost } from '@namzu/browser'
import { toolset, createBrowserTools } from '@namzu/sdk'

const host = new PlaywrightBrowserHost({
  profile: 'work',
  sites: {
    'https://github.com': 'act',
    'https://*.github.com': 'read',
    '*': 'ask',
  },
})
for (const warning of host.warnings) console.warn(warning)

const tools = toolset('browser', createBrowserTools(host))

async function shutdown(): Promise<void> {
  await host.dispose()
}
```

Where the browser runs, and whether its window is shown, is decided from the
environment. Call `detectBrowserEnvironment` to see the decision without
launching anything:

```ts
import { detectBrowserEnvironment, nodeBrowserProbes, runnableBrowserPlan } from '@namzu/browser'

const plan = runnableBrowserPlan(
  detectBrowserEnvironment(process.env, process.platform, nodeBrowserProbes, {
    mode: 'unattended',
  }),
)
console.log(plan.engine, plan.headless, plan.unavailableReason ?? 'ready', plan.warnings)
```

## WSL

Inside WSL, with interop on and Chrome or Edge installed on Windows, the
host drives the Windows browser (`windows-cdp`): the window appears on the
Windows desktop, and sites see a Windows browser. Nothing is installed on
Windows. The host starts `powershell.exe` through interop with a script that
starts the browser on a dedicated profile under
`%LOCALAPPDATA%\namzu\browser\profiles\<name>` with remote debugging on a
port the browser picks, and relays CDP over the script's standard streams,
because WSL's default NAT networking cannot reach Windows' `127.0.0.1`.
Playwright connects to a relay on WSL's `127.0.0.1` at an unguessable path.
Under mirrored networking the host connects to the browser's port directly
and uses the relay only if that fails.

```ts
import { PlaywrightBrowserHost, detectBrowserEnvironment, nodeBrowserProbes } from '@namzu/browser'

// Edge instead of Chrome, headless, for a run nobody watches.
const plan = detectBrowserEnvironment(process.env, process.platform, nodeBrowserProbes, {
  mode: 'unattended',
  windowsBrowser: 'msedge',
})
const host = new PlaywrightBrowserHost({ profile: 'reports', plan, windowsLaunchTimeoutMs: 90_000 })
```

- The operator's own Chrome profile is never used or touched: Chrome 136
  and later refuse remote debugging on it anyway.
- Every namzu process on a profile shares one browser. The last one to
  finish closes it; `keepOpen` leaves it running. If namzu dies, the bridge
  closes the browser it started, and only that one.
- A systemd service has no `WSL_INTEROP`; the host hands `powershell.exe` a
  socket from `/run/WSL`.
- Adds about 2 ms to a snapshot and 35 ms to a screenshot; a 3.5 MB
  full-page screenshot takes about a second.

## What it enforces

Whatever the permission gate allowed:

- A `browser_act` call runs only if its `origin` is the live page's origin.
- A page may stay loaded only if its origin is at `read` or `act` in the site
  rules, or the caller asked to open it this session. A link, script or
  popup heading anywhere else is stopped before the request is sent. A
  redirect is caught when it lands and the tab is cleared to `about:blank`.
- A sign-in page, a second factor, a CAPTCHA, a bot check or an HTTP
  credential prompt stops the call with `browser_human_required` and the
  command that opens a visible window for a person.
- Nothing is typed into a password or one-time-code field, and their values
  never appear in a snapshot.
- Downloads are cancelled and reported. Text nobody can see (`aria-hidden`,
  off-page, transparent, 1-pixel) is left out of snapshots.

## Documentation

- [The browser host](https://github.com/cogitave/namzu/blob/main/docs/sdk/browser-host.md)
- [The browser tools](https://github.com/cogitave/namzu/blob/main/docs/sdk/browser-tools.md)

## License

FSL-1.1-MIT, converting to MIT two years after each release.
