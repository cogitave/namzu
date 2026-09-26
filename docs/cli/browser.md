---
type: Guide
title: The browser
description: The browser the interactive terminal drives — which browser runs where, profiles and signing in, the browser.sites rules and how they reach the gate, the review screen, the pause when a page needs you, and what the controls do not stop.
resource: packages/cli/src/browser/
tags: [cli, browser, permissions, profiles, wsl]
status: draft
generated: { by: process:claude-code, at: 2026-09-23T00:00:00Z }
---

# The browser

In the interactive terminal the model has two browser tools: `browser`, which opens and reads pages, and `browser_act`, which clicks, types and fills forms. They drive a real browser on a profile namzu owns, with its own cookies, never your everyday profile. You sign in to a site once, in a visible window, and the agent reuses that sign-in. The model never signs in, never types a password or a one-time code, and never chooses the profile.

The tools are the SDK's [browser tools](../sdk/browser-tools.md) over the [`@namzu/browser` host](../sdk/browser-host.md), which the CLI installs as a regular dependency. Nothing starts when namzu starts: the browser launches on the model's first browser call, and closes when the session ends (unless `browser.keepOpen`).

`namzu exec`, `exec --json`, `drain`, `acp` and the resident step never get the browser: nobody is at a window there to sign in or to answer a review. A scheduled job gets one only through its own grant: see [Scheduled jobs](#scheduled-jobs).

## Which browser runs where

`namzu browser status` and `namzu doctor` (`browser.installed`, `browser.engine`) say which one this machine would use. Nothing is launched to find out.

| Where namzu runs | Browser | Window |
| --- | --- | --- |
| WSL 2, interop on, Chrome or Edge installed on Windows | the Windows Chrome (else Edge), driven from WSL through a PowerShell bridge (`windows-cdp`) | a normal Windows window |
| WSL 2 without interop or a Windows browser | Chromium inside WSL, with a warning | through WSLg when there is a display |
| Linux with a display | Google Chrome if installed, else Playwright's Chromium | yes |
| Linux without a display | the same, headless | none; `namzu browser login` refuses and says why |
| macOS, Windows | Chrome (or Edge on Windows), else Playwright's Chromium | yes |

`browser.engine: windows` forces the Windows browser from WSL and `local` forces a browser this process launches. `browser.headless: always` never shows a window and `never` always does; `auto` shows one when there is a display. Playwright's Chromium is downloaded by `namzu browser install` (`--dry-run` shows what it would fetch); with Chrome installed, or Windows Chrome from WSL, there is nothing to install.

## Profiles and signing in

A profile is a browser user-data directory. Its descriptor lives in `NAMZU_HOME/browser/profiles/<name>.json`; the data itself is next to it, or for the Windows browser under `%LOCALAPPDATA%\namzu\browser\profiles\<name>` (Chrome refuses remote control of your default profile). Names are lowercase words joined by hyphens.

```sh
namzu browser login work https://github.com/login   # a visible window on profile "work"
namzu browser list                                   # profiles, browser, last sign-in
namzu browser status work                            # this machine's browser, and the profile
namzu browser remove work --yes                      # delete it and every sign-in in it
```

`login` opens the window at the address (a bare `github.com` works) and returns when you press Enter in the terminal or close the window. It records the sign-in time, and says how the TUI (`/browser profile`) and a scheduled job (`--browser <profile>`) use the profile. Every site may load during a login: you are driving.

The TUI uses `browser.defaultProfile` (`default` when unset). `/browser profile <name>` switches for the rest of the session, closing the browser if it was open; the next browser call starts it on the new profile. A project file may not set `defaultProfile`: a profile holds your sign-ins, and a repository must not choose which ones its agent runs under.

## Site rules

```yaml
# ~/.namzu/config.yaml
browser:
  defaultProfile: work
  sites:
    "https://github.com": act
    "https://*.example.com": read
    "http://localhost:*": act
    "https://bank.example": deny
    "*": ask
```

| Level | Opening a page | Changing a page (`browser_act`) |
| --- | --- | --- |
| `deny` | refused | refused |
| `read` | without asking | refused |
| `ask` | reviewed | reviewed |
| `act` | without asking | without asking |

`*` is every site no other key names, `ask` when absent. A key is `scheme://host`, with `*.` for one or more whole labels (`https://*.example.com` is not `https://example.com`), `:port`, or `:*` for any port. No port means the scheme's default. A key that cannot be read (a path, a wildcard inside a host, a scheme other than http and https) stops namzu from starting, with the key named: a rule that vanished silently would be a deny you believe in and the gate never sees.

The same site written twice (`https://GitHub.com/` and `https://github.com`) keeps the narrower level. Across files the table is merged per site, and a deny holds: a project file can add sites and narrow them, but cannot reopen a site the user or managed file denied, cannot add sites once a file above it set `"*": deny`, and cannot switch the browser on when one switched it off (`enabled: false`). None of `browser` comes from the environment.

**How they are enforced.** The sites compile to rules on the two addresses the tools canonicalise: the `url` a navigation loads and the `origin` an action names. The gate sees the canonical form (`HTTPS://GitHub.com.:443/x` is `https://github.com/x`), and a rule for `https://github.com` does not match `https://github.com.evil.example`, `https://evil.example/?https://github.com`, `https://github.com:8443` or a lookalike host. Deny rules go first, then the most specific site, then `*`, which is the order the host uses too. Looking at the page the browser holds (`snapshot`, `screenshot`, `scroll`, `wait_for`, listing and switching tabs) is allowed; the browser tools are network tools, which are otherwise reviewed even when they only read. `back`, `forward` and `reload` name no address and follow your permission mode. A `[permissions]` deny for `browser` or `browser_act` still wins over every site.

The host then checks what actually happened: a link, a script or a redirect heading for a site the rules do not allow is stopped before it leaves (a click on a link to an `ask` site is blocked, and the model has to open the address, which you review); a page that lands somewhere not allowed is cleared to `about:blank`; and an action runs only if the live page is still on the origin the call named.

## The review screen

A reviewed browser call says what it does in words (`Open a web page`, `Click on https://shop.example`) and names the rule that asked:

```text
Open a web page
site rule: https://tr.wikipedia.org (any other site) → ask · profile work · windows-cdp
  Open: https://tr.wikipedia.org/wiki/İstanbul
  sent as: https://tr.wikipedia.org/wiki/%C4%B0stanbul

Do you want to open this page?
❯ 1. Yes
  2. Yes, allow all tools for this session
  3. No, and tell namzu what to do differently (esc)
```

The address shows its path the way a person writes it, and the address actually sent when the two differ; the host stays in its canonical punycode form. Typed text is shown whole, with hidden characters made visible. `d` shows the exact input. `/browser` shows the engine, profile and sites in force.

## When a page needs you

A sign-in page, a second sign-in step, a CAPTCHA, a bot check or an HTTP authentication challenge stops the call before the model is called again, and the turn pauses:

```text
‖ The browser needs you: https://github.com is showing a sign-in page.
  Sign in to https://github.com in the browser window (profile work), then press Enter to continue · Esc to stop.
```

Do it in the window and press Enter; the turn continues, and the model is told you dealt with it, so it opens or reads the page again rather than taking the sign-in page as the answer. Esc stops the turn. With no window (headless), namzu closes its browser to free the profile and gives the command instead:

```text
  namzu browser login work https://github.com/login
```

Run it in another terminal, sign in, close the window, then press Enter. Nothing is ever typed into a password or one-time-code field by the agent, whatever a rule allows.

An HTTP 401 or 407 alone is not a password prompt. The browser pauses for HTTP authentication only when the response carries the matching authentication challenge header. The notice asks you to check access in the browser window; a challenge does not guarantee that the browser has a sign-in form. `namzu browser login` does not update the profile's "last sign-in" time for this reason alone. A bare 401 or 407 is reported as a failed page load with its status, unless the page independently shows a sign-in, CAPTCHA or bot check. The agent should tell you that the site or proxy refused the request rather than ask you to enter a password based on the status alone.

## Scheduled jobs

A [scheduled job](scheduled-tasks.md#browser-access) drives the browser only with a grant: `namzu schedule add … --browser <profile> --browser-site <site>=read|ask|act`, or a grant the model proposes in the TUI and you confirm. It lists every site it may open; there is no `*`, and every other site is denied. It runs on the profile you signed in to with `namzu browser login`, with no window unless `--browser-headed`, and a page that needs you stops the run and notifies you (`needs you: Sign in to …`) instead of pausing at a window. Sign in again with `namzu browser login`, then continue the run with `namzu resume` (Continue). The Windows browser from a scheduler service in WSL: [The scheduler service](scheduler-service.md#windows-and-wsl-task-scheduler).

## What this does not stop

- **Page text is the site's, not yours.** Every snapshot is framed as untrusted content, and the tool descriptions tell the model it is data, but a page can still word itself as instructions. The frame marks where text came from; it does not refuse anything. The boundary is the site rules, the origin check, the review of `ask` sites, and the refusal to type credentials.
- **An allowed site can carry anything it serves.** `act` on a site means the agent changes it without asking, including what a hostile page on that site asks it to do. Give `act` to sites you would let a script drive.
- **A declined call is one call.** Answering No refuses that call and tells the model not to get the same content another way (another tool, site or a web search) without asking you first. That is an instruction the model reads, not a control: only the site rules and the review stop a call. Say what you want instead.
- **The session's cookies are real.** A profile signed in to a site is signed in for every call the rules allow on it. Use a separate profile for anything sensitive, and `namzu browser remove` when done.
- Downloads are cancelled, JavaScript cannot be run by the model, and `file:`, `chrome:` and cloud-metadata addresses are refused in every spelling.

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `browser.enabled` | `true` | Mount the browser tools in the TUI. `false` in any file holds. |
| `browser.defaultProfile` | `default` | The profile the TUI starts on. Not settable in a project file. |
| `browser.engine` | `auto` | `auto`, `windows` (the Windows browser from WSL) or `local`. |
| `browser.headless` | `auto` | `auto`, `always` or `never`. |
| `browser.sites` | `{ "*": ask }` | Site key to `deny`, `read`, `ask` or `act`. |
| `browser.keepOpen` | `false` | Leave the browser running when the session ends. |

## Commands

| Command | Exit codes |
| --- | --- |
| `namzu browser login <profile> [url]` | 0 done, 64 bad arguments, 69 no window can open here or the profile is in use |
| `namzu browser list [--json]` | 0 |
| `namzu browser status [profile] [--json]` | 0, or 69 when no browser can run here |
| `namzu browser install [--dry-run] [--force]` | 0, 1 when the download failed |
| `namzu browser remove <profile> [--yes]` | 0, 1 when it does not exist or is in use, 64 without `--yes` and no terminal |

`--home <dir>` overrides `NAMZU_HOME` for `login`, `list`, `status` and `remove`.
