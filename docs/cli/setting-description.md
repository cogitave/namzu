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
| `confirm`, `confirmWhen`, `confirmValue`, `confirmValues` | The sentence asked before a change, and which new value asks: `on`/`off` for a switch, `zero` for a cap, one option, or each of several options (`permissions.defaultMode` asks only for `accept-edits`, `bypass` and `auto`). Saving the value a setting already holds never asks; clearing a setting always asks. |
| `requires` | Another setting this one does nothing without. The screen warns while that setting is not in the needed state: `compaction.idleCompaction` needs `compaction.promptCacheTtl` at `1h`. |
| options | Each choice is `{ value, label, help }`. The saved `value` never changes; the label is plain words and `help` is one line saying what choosing it does. |

`defaultText` is still sent for an older Desktop that reads only words: the engine fills it from the typed
default. A newer Desktop ignores it when `default` is present.

## When a change applies

The apply time is found from the code that reads the key, not guessed.

- **Next start**: the default. The terminal app's own keys (`tui.*`, `composerTriggers.*`,
  `statusLine`), updates, telemetry, the schedule daemon, plugins, learning, `limits.*`, `workflow.*`
  and every key whose reader was not traced to conversation creation. The loaded config is kept for
  the life of the process and Desktop has no reload path, so a screen never promises more than the
  code does.
- **Next conversation**: only keys traced to the code that creates a conversation: `handBack.enabled`,
  `skills.builtin`, `compaction.softTargetHeadroom` and `compaction.recallEvidence`. An open
  conversation keeps the value it began with.
- **Now / next launch**: Desktop's own switches take effect at once; the graphics card, the start-up
  screen and the terminal restore are read when the app opens.

## What a write checks

Desktop writes only the user file, and every write is checked as the loader would read the file after it.
Beyond each key's own reader there are checks across keys and on one value:

- `model: auto` is refused, in plain words, while `routing` has no `default`, and removing that default is
  refused while the model is `auto`, so Desktop never leaves a file the terminal app refuses to load.
- A plain `learningGenerator: true|false` becomes `{ enabled }` when one of its token numbers is written
  beside it, so the switch is kept.
- Clearing `telemetry.sessionExport.destination` removes the whole `sessionExport` block (the loader
  refuses a block with no destination); the two choices beside it go with it.
- `telemetry.otlp.endpoint` must be an `http` or `https` address with no user name or password, and
  `browser.defaultProfile` must be a profile name (lowercase letters and digits, single dashes, 64 at most).

Number boxes take the engine's range (`workflow.maxConcurrency` 1 to 16, `schedule.maxConcurrentRuns` 1
to 16, learning tokens 1000 to 10000000, `limits.timeoutMs` up to 2147483647). A box in milliseconds takes
minutes and seconds (`5m`, `90s`) and stores milliseconds; a token box takes `786k` or `1m`.
`plugins.launchDirs` has no control: the loader never reads it from a file, and `--plugin-dir` sets it for
one run. A file-only row (profiles, decision model, status line, trace headers, connected servers, hooks)
names the config file it lives in.

## The guard

`packages/cli/src/config/settings-descriptors.test.ts` reads the property names of `NamzuCliConfig`
from `schema.ts` and fails, naming the key, when one has neither a description nor an entry in
`SETTING_EXCLUSIONS` with a reason. It also fails when a default does not fit its control, when a choice
has no help line, or when an apply time is missing.

## Read side

The engine's answer carries an optional `layer` on each saved value (the file it came from: `user`,
`project`, `local`, `profile` or `managed`). It is not filled yet; Desktop already reads it.
