---
'@namzu/cli': patch
---

The background runner for extensions that start at sign-in is no longer started inside Namzu's own process tree. On Windows Namzu starts it through its registered task (`\Namzu\Extension Runner`), or through `cmd start` when there is no task, so stopping the app by force no longer stops a recording that is meant to keep running. Linux and macOS are unchanged. An extension may have no tray icon of its own; one is required only when it runs in the background and declares personal data, and the refusal for a manifest that breaks that rule now says exactly this.
