---
type: Reference
title: Computer use settings
description: The computerUse config table: the switch that offers the computer tools (off by default, opened only from your own or the managed file, followed live in an open conversation), what the model is told about it, the list of apps they never act in and where it is enforced, and why Namzu has no unhide-apps setting.
resource: packages/cli/src/config/load.ts
tags: [cli, computer-use, settings, permissions]
status: draft
generated: { by: process:claude-code, at: 2026-11-18T00:00:00Z }
---

# Computer use settings

```yaml
computerUse:
  enabled: true            # default false: no computer tools in any conversation
  deniedApps:              # apps the computer tools never act in
    - Banking
    - Password Manager
  browserWindows: ask      # look | ask (default) | act: what happens in a browser window you have open
```

| Key | Default | Who may set it |
| --- | --- | --- |
| `enabled` | `false` | **Only the user file and the managed file** can turn it on. A project file or local file can only say `false`; its `true` is dropped. The managed file wins over the user file, so an administrator can lock it off. |
| `browserWindows` | `ask` | The user file and the managed file set it (the managed one wins). A project or local file can only **tighten** it (`act` to `ask` to `look`); a looser value is dropped, so a repository cannot make a clone of itself click in your browser. |
| `deniedApps` | empty | Any file. The lists add up across files and no file removes another's entry (a name matches without regard to case, spaces or a trailing `.exe`). |

Neither is read from the environment.

## Browser windows

A browser window you already have open (your own sign-ins, your admin pages) is not Namzu's own browser: the
`browser` tool drives a separate profile where you have not signed in. `computerUse.browserWindows` says what
`computer_use` may do in your window.

| Value | What happens |
| --- | --- |
| `look` | Namzu sees the window (screenshots, controls, scroll) and does not click or type in it. This was the only behaviour before the setting. |
| `ask` (default) | Looking is free. The first action aimed at a browser window in a conversation asks you: *Let Namzu click and type in Brave in this conversation?* with *Allow for this conversation* and *Not now*. Only your answer allows it, for that browser in that conversation. |
| `act` | Namzu clicks and types in browser windows like in any other app. |

Under `ask` the question is the engine's own and goes through the same channel as the screen question: the
terminal's question card, and in Desktop an approval card (`browser_window`, marked `alwaysAsk`). No permission mode
answers it, auto and a remembered *allow for this conversation* included, and a run with nobody to ask (`exec`,
a scheduled task) never gets the grant and stays look-only. *Not now* holds for the rest of the turn so the model
does not ask twice. The grant is per browser and per conversation (a new conversation asks again) and the tool can
take it back (`revokeBrowserGrant`). The setting is read at every call: switching *Browser windows* to *Only look* in `/config` or Settings takes every grant back from the next action. A grant covers every window of that browser, private ones and other profiles included, and Desktop's per-app card for the browser is answered separately from this one. There is no other revoke row yet; the grant ends with the conversation. With nobody to ask when the conversation starts (no question channel), the tool and the prompt say look-only.

What still asks, with or without the grant: Namzu is told to ask, and the engine enforces only part of it. The tool refuses `type_text` while the focused control of the latest `ui_snapshot` is a password field, and `ui_act set_value` on one, in a browser; the rest is the model's guidance and the review cards, and `auto` or `bypass` do not add a per-click question. The tool treats a key or control named like deleting, sending,
posting, publishing, submitting, paying, accepting or agreeing, confirming, or a password, passcode or card number as
a consequence to answer for, every click is still a change that a review asks about, and the model is told to
stop and ask before it types into a password field, submits payment or personal data, sends or posts, deletes,
accepts terms or changes organisation-wide admin settings. A denied app (`deniedApps`) stays off limits whatever
this says.

When an action on a browser window is refused or not granted yet, the tool result gives the model three ways forward to
offer in plain words: allow it for this conversation (or, under `look`, change *Browser windows* in Settings);
continue in Namzu's own browser, where you sign in once; or you click while Namzu guides from screenshots.

## What `enabled` does

Off, `computer_use` is not offered: not in the terminal app, and not in a Desktop conversation that uses
this computer. On, the tool is offered, and every request to use an app still goes
through the usual questions (the one-time *Share your screen* box in the terminal, the per-app card
in Desktop). A Pal's own computer is a separate thing and is not switched by this key.

### Turning it on in an open conversation

The switch is read before every message, so turning it on in `/config computerUse.enabled on`, in
`namzu config set` or in Settings, Tools takes effect from the next message in a conversation that is
already open, and turning it off takes the tool out of the next request. Nothing about the desktop is
started while the switch is off. The first time it is on, the desktop host starts then (on Windows, and
in WSL, which uses the Windows desktop, that first start can download the small helper it needs). If the
host cannot start, the tool stays out of the requests with the reason shown, is not retried while the
switch stays on (the model is told why, and tells you), and is tried once more after the switch is turned off and on again. The tool adds about
900 tokens to a request only while it is offered, and each flip changes the tool list once, so the next
request is not served from the prompt cache.

The *Share your screen* box and the confirmation when you turn the switch on are unchanged.

### What the model is told

In a surface that offers the tool, the environment block carries one fixed line: computer use is a switch
the person controls, the tool is absent when it is off, the person turns it on with
`/config computerUse.enabled on` (or Settings, Tools), and the model never turns it on itself but says so
in one line when it needs it. The line is the same whether the switch is on or off, so a flip never
rewrites the cached prompt prefix. It is left out of `exec`, `drain`, Pal conversations, sub-agents, when
`@namzu/computer-use` is not installed and when the model's driver cannot carry an image. The agent
settings tools stay read-only for this key.

### The default

The default stays off. It is a consent choice beside the bypass opt-in: the tool sees the screen and
drives the mouse and keyboard, so only you, or an administrator through the managed file, can turn it
on, and a project file's `true` is dropped. Being on WSL is not the reason a conversation has no computer
tool: WSL maps to the Windows desktop. Making it on by default would be a separate major change to
`computerUse.enabled`; anyone who wanted to keep the old behaviour would set it to `false`.

## What `deniedApps` does

The list is enforced by the `computer_use` tool itself, before any call reaches the screen (see
[Applications put off limits](../sdk/computer-actions.md#applications-put-off-limits)), so it holds in the
terminal app, in Desktop and in `namzu acp` alike, and a prompt that asks otherwise changes nothing.
The tool is told the list when the conversation starts (`computerUse.deniedApps` still applies to new conversations only; an open one keeps the list it began with). In Desktop the usual card may still be drawn for a
call in a listed app before the tool refuses it. On a computer whose host cannot tell which app a click
would land in (a pixel-only display), a non-empty list stops the acting calls altogether, because the
tool cannot check them.

The tool also keeps to a tier per kind of app regardless of this list: browser windows are looked at only,
terminals and editors are clicked but not typed into
([Application tiers](../sdk/computer-actions.md#application-tiers)). The list is the person's own override on top.

## Settings

A name must be written as the app is named in its window list; capital letters and a closing `.exe` do
not matter. A project file can add an app but cannot remove one you listed.

Settings, Tools has a *Computer use* heading with *Enable computer use* and *Denied apps*. The list
shows a note while the switch is off, and the app names read in the interface font. Turning it on asks first.

## No setting to unhide apps

Namzu never hides, minimises or covers another app while it works. The only thing it hides is its own
cursor and border overlay. After a burst of work that needed the foreground it puts the window and the
pointer you had back, which always happens and has no switch. So there is nothing for an *Unhide apps
when it finishes* row to switch, and it is not offered.
