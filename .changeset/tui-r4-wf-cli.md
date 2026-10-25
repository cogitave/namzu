---
'@namzu/cli': patch
---

Terminal: a dialog or picker no longer shows a half footer under it (the model name alone, or the mode without its cycle hint); the footer is drawn only with the message box. A workflow whose agent failed now says `1 failed` beside the count in the workflow view and on the rail where the row has room. A `+500k` token target is read only from what you typed, so a note Namzu adds on its own (a finished job, peer mail, a goal round) can no longer set one. `namzu exec`, `exec --json` and ACP still read a `+500k` in the prompt you give them, on the first turn only; scheduled and resident runs never carry one.
