---
"@namzu/sdk": minor
"@namzu/computer-use": patch
---

Add optional exact desktop `supportedActions`, `mouseClickButtons` and
`mouseDragButtons` capabilities. The computer-use tool uses them in its model
schema and rejects unsupported operations before contacting the desktop.
Custom hosts that omit these fields retain broad-flag behavior.

Native adapters now publish supported actions. On macOS, unavailable scroll,
move and drag actions are no longer advertised as usable. Middle clicks and
non-left drags fail explicitly instead of accidentally performing a triple
click or a left drag. Left/right click support depends on cliclick availability.
