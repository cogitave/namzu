---
type: Reference
title: Opening a page in your browser
description: The open_url tool — which sessions have it, how it reaches the browser on each platform (the Windows browser under WSL), its review, and what its result does and does not claim.
resource: packages/cli/src/integrations/web/open-url.ts
tags: [cli, tools, web, wsl]
status: stable
generated: { by: process:claude-code, at: 2026-09-24T00:00:00Z }
---

# Opening a page in your browser

When you ask for a page to be opened ("open example.com in my browser"), the
model calls `open_url` with the address. It opens in your default browser, on
your desktop. The tool takes one input, `url`, and accepts only `http://` and
`https://` addresses: a `file:` path, `javascript:` or a program name is
refused before anything starts.

## Where it is available

The interactive terminal and `namzu exec` have it: both run in front of you.
`exec --json`, `drain`, ACP, a resident worker and a scheduled run do not, and
no sub-agent does (`AgentSessionOptions.openUrl`).

## Review

`open_url` is a `network` tool that declares itself not read-only, so it is
reviewed like other outward actions: `prompt` mode asks before it runs, and a
`[permissions]` rule for `open_url` decides it like any other tool.

## How it opens the page

It uses the same opener as `namzu login` (`packages/cli/src/tui/open-browser.ts`).
No shell reads the address, and the launcher is named by absolute path, so a
same-named program earlier on `PATH` cannot answer instead:

| Platform | Launcher |
|---|---|
| Windows | `%SystemRoot%\System32\rundll32.exe url.dll,FileProtocolHandler <url>` |
| macOS | `open <url>`, found on an absolute `PATH` entry |
| WSL with interop | `<root>c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`, where `<root>` is `[automount] root` in `/etc/wsl.conf` (`/mnt/` by default), started in `<root>c` and running the fixed script `Start-Process -FilePath $env:NAMZU_OPEN_URL`, sent as `-EncodedCommand`. The address is passed only in `NAMZU_OPEN_URL`, which `WSLENV` names, so the script's text never contains it |
| Other Linux, or WSL without interop or PowerShell | `xdg-open <url>`, found on an absolute `PATH` entry |

Under WSL the page therefore opens in the Windows browser, and `namzu login`'s
sign-in page does too. It used to go to `xdg-open`, which under WSL usually
reaches nothing. The opener does not use `cmd.exe /c start`, because `cmd.exe`
treats `&` in a URL as a command separator. It does not use `explorer.exe`
either, because `explorer.exe` exits with status 1 even when it opened the
page. The WSL environment note tells the model about that exit status for when
it runs `explorer.exe` itself.

## What the result says

A result means a launcher **started**. No platform reports whether a tab
appeared. On success the result reads `Opened <url> in the user's default
browser: the launcher started.` When no launcher can start (a machine with no
desktop session, or no `xdg-open`), the call fails with
`No browser launcher is available on this machine`. The model then gives you
the address to open yourself.
