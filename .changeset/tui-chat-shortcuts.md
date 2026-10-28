---
'@namzu/cli': minor
---

New chat shortcuts. Ctrl+S sets the draft aside and brings it back (also after the next message you send); Ctrl+_ undoes edits to the draft; Alt+P opens the model chooser, adds nothing to the history and gives back what you had typed when the chooser closes; Alt+T switches thinking off and on for models that offer an off level (a note in the footer says so otherwise; `/effort` stays the chooser); a second Ctrl+S swaps with the draft already set aside instead of replacing it; Ctrl+X Ctrl+E opens your editor like Ctrl+G, and a missing editor names the key you pressed. One thing changes: Ctrl+S on its own used to start a forward history search that did nothing, so it now sets the draft aside; inside an open search it still steps to a newer match.
