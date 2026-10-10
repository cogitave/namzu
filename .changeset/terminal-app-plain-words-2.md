---
"@namzu/cli": patch
---

The terminal app and the command line read in plainer words. Nothing about how they behave changes, and exit codes stay as they were (64 for a usage mistake). A script that matches the old text needs the new one:

- An argument mistake such as `namzu --effort turbo` no longer prints commander's `error: option '--effort <level>' argument 'turbo' is invalid. Allowed choices are …`. It prints `“turbo” is not a valid value for --effort. Choose one of …`, wrapped at the terminal's width, then `Run namzu --help to see what is available.`; an unknown command reads `Unknown command 'x'.`.
- A command step in the transcript is headlined from the kernel's typed result (`ToolResult.facts`): `Ran npm test · exited with code 2`, the command's own first and last lines with `… N lines not shown`, no `STDOUT:` labels. A conversation saved before `facts` existed keeps the old reading. A call you declined reads `You declined this, so it did not run.`
- A picker or prompt prints its key hints once, in its own box, in one vocabulary (`↑↓ select · enter apply · esc back`); the footer under the composer stays quiet while a box is open, and a hint line that is too wide loses whole hints, never half of one.
- “Turn”, “session”, “checkpoint” and “compaction” no longer appear in what a person reads: replies, conversations and summaries instead (`/config` lists “Reply limits”). Sizes read `48 KB` and `1.2 MB`, counts are pluralised, no millisecond figures are shown, and the app’s errors give a sentence and a next step instead of a pasted message. First-run with no key says `Choose “Enter an API key” below`, and subscription sign-in rows say `uses a one-time code` or `opens your browser`.
- Person-facing text uses ’ in contractions, never inside code, flags, paths or JSON.

The `.tsx` files of the terminal app are now covered by the package's lint and format settings.
