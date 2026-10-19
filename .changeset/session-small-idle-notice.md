---
"@namzu/cli": minor
---

Terminal notifications gain an "idle" notice and two more channels. Add `"idle-prompt"` to `tui.notifications` to be told, once, when a finished turn has sat for a minute with nobody at the keyboard (no key pressed, no prompt or picker open, nothing queued or looping, background work done). `tui.notificationMethod` now also accepts `"kitty"` and `"ghostty"`. Nothing changes unless you opt in: `notifications: true` still means a settled reply and an approval prompt only, and `osc9` stays the default method.
