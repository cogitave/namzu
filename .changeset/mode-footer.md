---
"@namzu/cli": minor
---

The permission mode and the model/effort identity now share a single dim line directly below the message frame, instead of two separately-positioned indicators.

Before: the active permission mode (when it differed from `prompt`) was drawn as its own row *inside* the message frame, above the `›` input, growing the frame from three rows to four; the model, reasoning effort and working directory sat on a wholly separate status line, one blank row further down, with the interaction hint or durable goal on its right.

Now: one footer line, always present, immediately below the frame (the frame is a constant three rows). Left to right: the permission-mode badge, colored by mode, with its `(shift+tab to cycle)` reminder when the mode differs from `prompt` — or, in `prompt` mode, a quiet `shift+tab to cycle` in its place; a reasoning-effort override beside it as `· effort <level>`, only when the operator has set one (the previous line's unconditional `<model> default` is gone — an unset effort is no longer named); the working directory. On the right: the interaction hint or durable goal exactly as before, or — when neither is active — the model identity, which moved here from the left. The footer stays exactly one row at every width: on narrow screens the working directory shrinks and drops first (a path is recoverable, the mode is not), then the effort label, then the cycle-key reminder, then the model on the right, and only as a last resort does the mode badge itself truncate.

Nothing about what a mode does, or its name, changed — only where and how it is drawn. `PermissionMode`, `permissionModeLabel` and the Shift+Tab cycle order (`prompt` → `accept-edits` → `plan` → `prompt`) are untouched, and neither `Composer` nor `StatusBar` is part of this package's public entry point (`packages/cli/src/index.ts`) — a consumer importing `@namzu/cli` as a library sees no type or export change at all.

Minor, not patch: an operator running `namzu` sees a different screen on every launch — the mode fact and the identity fact move to a line neither used to share, an unset reasoning effort is no longer implied to be `default`, and a screenshot, recording or terminal-automation script keyed to the old two-indicator layout no longer matches. That is a behavior change worth a changelog entry even though no importable type moved.
