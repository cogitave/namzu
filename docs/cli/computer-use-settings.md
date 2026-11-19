---
type: Reference
title: Computer use settings
description: The computerUse config table: the switch that offers the computer tools at all (off by default, opened only from your own or the managed file), the list of apps they never act in and where it is enforced, and why Namzu has no unhide-apps setting.
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
```

| Key | Default | Who may set it |
| --- | --- | --- |
| `enabled` | `false` | **Only the user file and the managed file** can turn it on. A project file or local file can only say `false`; its `true` is dropped. The managed file wins over the user file, so an administrator can lock it off. |
| `deniedApps` | empty | Any file. The lists add up across files and no file removes another's entry (a name matches without regard to case, spaces or a trailing `.exe`). |

Neither is read from the environment.

## What `enabled` does

Off, `computer_use` is not offered: not in the terminal app, and not in a Desktop conversation that uses
this computer. On, the tool is offered as before, and every request to use an app still goes
through the usual questions (the one-time *Share your screen* box in the terminal, the per-app card
in Desktop). A Pal's own computer is a separate thing and is not switched by this key. The change
applies to conversations started after it.

The default changed from on to off in the release that adds this key: before, the terminal app and Desktop always
offered the tool when the package was installed. To keep that, set `computerUse.enabled: true` in
your own config file or turn on *Enable computer use* in Settings, Tools.

## What `deniedApps` does

The list is enforced by the `computer_use` tool itself, before any call reaches the screen (see
[Applications put off limits](../sdk/computer-actions.md#applications-put-off-limits)), so it holds in the
terminal app, in Desktop and in `namzu acp` alike, and a prompt that asks otherwise changes nothing.
The tool is told the list when the conversation starts. In Desktop the usual card may still be drawn for a
call in a listed app before the tool refuses it. On a computer whose host cannot tell which app a click
would land in (a pixel-only display), a non-empty list stops the acting calls altogether, because the
tool cannot check them.

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
