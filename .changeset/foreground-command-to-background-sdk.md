---
'@namzu/sdk': major
---

A foreground `bash` call whose turn is cancelled by the person (an abort carrying `TurnCancelled('user')`) no longer kills the command when the host's job registry can take it over: the process becomes a background job under the turn's owner, the call returns normally with its output so far and a line saying it moved, and `data` carries `movedToBackground: true` and `backgroundedBy: 'interrupt'`. Cancellations caused by a parent, a budget or a hook still kill it. If your host relied on a cancel ending the command, call `registry.killOwner(owner)` when the session or turn ends, or set `NAMZU_DISABLE_BACKGROUND_TASKS=1` to keep the old kill (this also refuses `run_in_background`).

New: a running command is offered for hand-over after two seconds (`FOREGROUND_HANDOFF_AFTER_MS`). `BackgroundJobRegistry` gains `registerForeground`, `foregroundCommands`, `backgroundForeground(owner, 'user' | 'message')` and `onForegroundChange`, the bound registry a tool receives gains `registerForeground`, and the types `ForegroundCommand` and `ForegroundHandoffReason` are exported. `execHostShell` takes `adopt`, `adoptOnInterrupt` and `onRunning`, and reports `backgroundedBy`.
