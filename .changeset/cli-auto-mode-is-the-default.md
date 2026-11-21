---
'@namzu/cli': major
---

The interactive terminal now starts in auto mode by default. The old default was `prompt` (ask before changes); the new one is `auto`, the mode in which a second model checks each action that would otherwise ask you and blocks the risky ones.

It applies only when nothing chose a mode: no `--permission-mode`, no `--yolo` or `--dangerously-skip-permissions`, and no `permissions.defaultMode` in your user file, the managed file or the project's file. It does not apply when `permissions.disableAutoMode: true` is set anywhere, and the terminal starts in `prompt` as before when the classifier cannot reach a model (for example a `permissions.autoMode.model` this machine has no credential for). `namzu exec`, `exec --json`, scheduled runs, sub-agents and workflows, Pals, `namzu peers send`, and the sessions Desktop and ACP clients own keep their current modes.

To keep being asked before changes, set this in `~/.namzu/config.yaml`:

```yaml
permissions:
  defaultMode: prompt
```

or start with `--permission-mode prompt`, or press Shift+Tab once. `permissions.disableAutoMode: true` removes auto mode altogether.

Also in this release:

- The first time a terminal starts in auto because of the default, the transcript shows a one-time notice saying so, what auto does and how to change it. It is recorded as `autoModeDefault` in `~/.namzu/acknowledgements.json` and never shown when you chose auto yourself.
- When auto mode gets no verdict three times in a row (the model cannot be reached, or its answers cannot be read), the turn stops with one sentence and nothing runs; send a message to try again or press Shift+Tab. `exec` says the same and exits 1. A call held back for want of a verdict is told it may be tried again, not that it was blocked.
- The Settings row for `permissions.defaultMode` shows auto as its default for the terminal, and clearing a saved value now asks first, since it turns auto back on. `/permissions` with details says when auto is the terminal's default.
