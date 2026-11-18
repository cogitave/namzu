---
'@namzu/sdk': minor
---

`createComputerUseTool` gains `onObservation` (told, after each call that returned a screenshot, the picture made small, the application and where a click landed) and its tool now has `appOf(input)`, `appsOf(input)` (every application a batch reaches) and `consequence(input)`: the application a call works on, and why a call should be put to a person even in an allowed application (a key that closes or deletes, or a control that discards, sends or submits). The first call in each application presents as "Using <application>". The ACP permission request's calls may carry `computer: { app, apps?, consequence }`. Existing callers change nothing.
