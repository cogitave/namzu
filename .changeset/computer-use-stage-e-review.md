---
'@namzu/computer-use': patch
---

Computer use on Windows no longer reports typed text as delivered because an unrelated label changed, no longer types into a dialog that happens to share the program, no longer stops a run when the front window cannot be read, and no longer tells the model that input was dropped (and is safe to repeat) unless an administrator window was actually in front. A cancelled action stops waiting for a helper that does not answer.
