---
'@namzu/cli': major
---

The interactive terminal now starts in auto mode by default. The old default was `prompt` (ask before changes); the new one is `auto`, the mode in which a second model checks each action that would otherwise ask you and blocks the risky ones.

It applies only when nothing chose a mode: no `--permission-mode`, no `--yolo` or `--dangerously-skip-permissions`, and no `permissions.defaultMode` in your user file, the managed file or the project's file (a project's `defaultMode` keeps the terminal out of auto and starts it in `prompt`, as before). It does not apply when `permissions.disableAutoMode: true` is set anywhere, and the terminal starts in `prompt` as before when the classifier cannot reach a model (for example a `permissions.autoMode.model` this machine has no credential for). `namzu exec`, `exec --json`, scheduled runs, sub-agents and workflows, Pals, and the sessions Desktop and ACP clients own keep their current modes.

`namzu peers send` with no `--mode` now acts in the mode a new terminal would plan to start in, so it reaches a terminal in its default (auto). A script that sends to a terminal that started in `prompt` because auto could not be used there, or to one someone switched to `prompt`, passes `--mode prompt`.

To keep being asked before changes, set this in `~/.namzu/config.yaml`:

```yaml
permissions:
  defaultMode: prompt
```

or start with `--permission-mode prompt`, or press Shift+Tab once. `permissions.disableAutoMode: true` removes auto mode altogether.

Also in this release:

- The first time a terminal starts in auto because of the default, the transcript shows a one-time notice saying so, what auto does, how to change it and that `/permissions` explains the modes. It is recorded as `autoModeDefault` in `~/.namzu/acknowledgements.json` and never shown when you chose auto yourself. A later `/model` that takes a terminal in its default into or out of auto says so in one line.
- When auto mode gets no verdict three times in a row (the model cannot be reached, or its answers cannot be read), the turn stops with one sentence and nothing runs. If you chose auto, it stays on: send a message to try again or press Shift+Tab. A terminal in auto only by default goes back to asking before changes, as it does after too many blocks; `/permissions auto` turns it on again. `exec` says the same and exits 1, and in Desktop each refused call says the turn was stopped. A call held back for want of a verdict is told it may be tried again, not that it was blocked, and a command too long for the check to read is told to be split up.
- The Settings row for `permissions.defaultMode` shows auto as its default for the terminal, and clearing a saved value now asks first, since it turns auto back on; the agent's `get_settings` reports that default with the same note. `/permissions` with details says when auto is the terminal's default.
