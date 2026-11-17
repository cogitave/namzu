---
type: Concept
title: The setting description
description: The one typed description every setting has (default, choices, when a change applies), who reads it, and the guard that keeps it complete.
resource: packages/cli/src/config/settings-descriptors.ts
tags: [cli, desktop, config, settings]
generated:
  by: namzu/settings-typed-description
  at: 2026-11-18
---

# The setting description

A setting is described once. Settings in Desktop, the search list and (later) `/config` and
`namzu config` draw their default, their choices and their "applies" line from that description and from
nothing else. A screen never reads a default out of a sentence.

Two files hold descriptions, written in the same shape:

- `packages/cli/src/config/settings-descriptors.ts` describes the keys of the user config file. The
  engine hands the list over (`namzu/config/describe`) and Desktop draws controls from it.
- `packages/desktop/src/shared/settings-catalogue.ts` describes what Desktop owns: the preferences in
  `desktop-settings.json`, the appearance choices, and the panels with no single value (projects, voice,
  versions). It is also the validator for a saved or requested change and the source of the search list,
  so a key added there is checked, drawn, found by search and given its default with no second edit.

## What a description says

| Field | Meaning |
|---|---|
| `default` | What the setting holds when nothing is saved, as a value: on or off, a number, the chosen option, or the ticked options of a list. A setting with no one default (a size worked out from the model, for example) has none and says so in `defaultText`. |
| `defaultNote` | A caveat beside the default, such as "Off in automated runs such as CI". |
| `defaultWhen` | Cases where the default is not `default`: `sandbox.enabled` is off unless isolation is required or the workspace is a throwaway copy, and then it is on. |
| `appliesWhen` | `now`, `next-turn`, `next-conversation`, `next-start` or `next-launch`. Every setting has one. |
| options | Each choice is `{ value, label, help }`. The saved `value` never changes; the label is plain words and `help` is one line saying what choosing it does. |

`defaultText` is still sent for an older Desktop that reads only words: the engine fills it from the typed
default. A newer Desktop ignores it when `default` is present.

## When a change applies

The apply time is found from the code that reads the key, not guessed.

- **Next start**: the terminal app's own keys (`tui.*`, `composerTriggers.*`, `statusLine`), updates,
  telemetry, the schedule daemon, plugins, learning, and the keys whose reader was not traced to a
  conversation. A key that is not traced is given `next-start`, the later claim, so a screen never
  promises more than the code does.
- **Next conversation**: what the engine reads when it creates a conversation: limits, compaction,
  memory, skills, workflow, permissions, sandbox, web, browser and hooks. An open conversation keeps
  the value it began with.
- **Now / next launch**: Desktop's own switches take effect at once; the graphics card, the start-up
  screen and the terminal restore are read when the app opens.

## The guard

`packages/cli/src/config/settings-descriptors.test.ts` reads the property names of `NamzuCliConfig`
from `schema.ts` and fails, naming the key, when one has neither a description nor an entry in
`SETTING_EXCLUSIONS` with a reason. It also fails when a default does not fit its control, when a choice
has no help line, or when an apply time is missing.

## Read side

The engine's answer carries an optional `layer` on each saved value (the file it came from: `user`,
`project`, `local`, `profile` or `managed`). It is not filled yet; Desktop already reads it.
