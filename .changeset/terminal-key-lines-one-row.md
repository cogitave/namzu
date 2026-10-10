---
"@namzu/cli": patch
---

The terminal app's key lines stay on one row, a cut list says what it hides, and a stopped start reads cleanly. Nothing about what a key does changes. A script that matches the old screen text needs the new one:

- The line of keys at the bottom of the provider picker (and every other picker and dialog) is one row at any width, from 40 columns up. Where it used to wrap, it now drops its least important hints or says them short: `↑↓ or 1–9 select` becomes `↑↓ select`, `esc or ctrl+c exit` becomes `esc exit`, `k enter an API key` becomes `k API key`. `↑↓ select`, `enter apply` and the key that leaves stay to the end. The sign-in and key-entry screens put their keys on a line of their own instead of at the end of a sentence.
- A provider list that is cut to the height of the terminal shows `↓ 3 more` under the last row and `↑ 2 more` above the first, and keeps the row under the cursor in view.
- A `namzu.config.json` that cannot be read shows its sentence alone, without a leading `·` and without the second "Startup stopped / Resolve the error above, then restart Namzu." block, which stays only under errors that do not say what to do. A screen with no composer no longer prints `shift+tab to cycle` in its footer.
- Node 22's `ExperimentalWarning: SQLite is an experimental feature and might change at any time` is no longer printed above the banner. Every other Node warning still prints.
- The slash menu (and the file menu) fits its key line to the width it really has, so `tab complete` no longer wraps at 60 columns or shrinks to a bare `tab` at 40, and a command's description is at most two lines ending in `…` where it goes on, so the menu is no taller than a 40-column terminal. A model list that keeps the current model says `esc keep` rather than losing `enter apply`, and "Could not list models" no longer ends in two full stops.
