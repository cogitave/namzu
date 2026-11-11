---
'@namzu/cli': patch
---

A paste no longer shows the end of its start or end marker as typed text (`[200~`, `[201~` in the message box) when the terminal delivers the marker in two pieces with a pause between them, which a slow or lossy remote connection can do. The unfinished marker is now held until the rest arrives (at most 200 ms when it could still be an arrow key or Insert, at most 2 s when it can only be a marker), then the paste is assembled as before, as one chip or as inline text, without submitting its newlines. The Escape key, arrow keys, Alt combinations and function keys are recognised on the same schedule as before. A pause right after the first byte of the marker cannot be told from pressing Escape and is not repaired. Nothing to change on your side.
