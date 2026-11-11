---
'@namzu/cli': minor
---

A turn that runs many shell commands no longer prints a block for each. A command that ends well, and is not one of the look-only commands that already folded, joins the line of what ran around it: `Read 3 files, ran 4 commands` (`running` while it is open), with the commands listed under it one per line as `$ command`, cut to the width, the last five, and a line saying how many earlier ones are not listed. Their whole output is still in the detailed transcript (Ctrl+O). A command that fails, was stopped, timed out, was blocked or declined, or moved to the background keeps its own row, and ends the line so the order on screen is the order things happened. One command on its own is drawn as before, with its output. The same line is drawn when a conversation is resumed.

Also: a call to a tool that does not exist is no longer counted as a look (`listed 1 directory`); it shows its own row with one sentence saying so, and the kernel's list of tools behind Ctrl+O. Nothing about what the model receives changes.
