---
'@namzu/cli': patch
'@namzu/sdk': patch
---

Display text only; nothing to change when you upgrade. If a script, test or screen-scrape reads the terminal's wording, these lines changed: composer tag rows no longer start with a `✦`/`✧` mark and are sentence case (`Hypermode · this reply: …`); `Press ctrl+x ctrl+k again to stop background agents` is a footer hint, not a transcript row, and the stop leaves `All background agents stopped`; an agent stopped by Esc or Ctrl+C now reads `was stopped by user` like one stopped from the rail; tool results hang from `  ⎿  ` (two spaces after the glyph) everywhere; `/workflows` rows read `finished` (not `completed`) with the duration first; `/compact` echoes `› /compact` and prints its result below the turns that stay. `@namzu/sdk` workflow scripts log `Step N stopped: <reason>` from `parallel()` (was `parallel item N failed: …`) and `Item N stopped at step M: <reason>` from `pipeline()` (was `pipeline item N stopped at stage M: …`); a script that matches on those log lines must change the match.
