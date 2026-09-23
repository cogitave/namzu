<!-- okf
type: Reference
title: "@namzu/browser"
description: >-
  A browser host for the SDK's browser tools: Chromium driven by Playwright on
  a persistent profile, accessibility snapshots with element refs, a site
  policy checked after every navigation, and a stop for anything only a
  person should do.
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

[Install](#install) · [Usage](#usage) · [What it enforces](#what-it-enforces) · [Documentation](#documentation)

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
import { ToolRegistry, createBrowserTools } from '@namzu/sdk'

const host = new PlaywrightBrowserHost({
  profile: 'work',
  sites: {
    'https://github.com': 'act',
    'https://*.github.com': 'read',
    '*': 'ask',
  },
})
for (const warning of host.warnings) console.warn(warning)

const registry = new ToolRegistry()
for (const tool of createBrowserTools(host)) registry.register(tool)

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

Inside WSL with a Windows Chrome or Edge, the plan names the Windows browser
(`windows-cdp`). This build does not drive it yet, so `runnableBrowserPlan`
falls back to Chromium inside WSL and says so in `warnings`.

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
