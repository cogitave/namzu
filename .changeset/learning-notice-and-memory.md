---
"@namzu/cli": minor
---

When Namzu's own learning activates a revision of a folder's guidance, the terminal now shows one dim row saying what was learned and how to take it back (`namzu learn --undo`); a rejected or inconclusive cycle shows nothing. The row stays in the transcript because the undo instruction must not disappear after a few seconds. Learned guidance is presented to the model as advice, and where it disagrees with a stored memory the memory wins. The read-first guard on edits (shown as "File must be read first") is not recorded as a learning observation. Nothing to change on upgrade; `learningGenerator: false` still turns learning off.
