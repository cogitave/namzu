---
'@namzu/cli': minor
---

New chat shortcuts. Ctrl+S sets the draft aside and brings it back (also after the next message you send); Ctrl+_ undoes edits to the draft; Alt+P opens the model chooser and Alt+T the reasoning-effort chooser without touching the draft; Ctrl+X Ctrl+E opens your editor like Ctrl+G. One thing changes: Ctrl+S on its own used to start a forward history search that did nothing, so it now sets the draft aside; inside an open search it still steps to a newer match.
