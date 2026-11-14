---
'@namzu/cli': patch
---

A reply is marked by a plain round dot in the text colour instead of the green `∴`, on the first text block of a reply only: a later block after a tool call lines up under the first and has no mark, while tool rows keep their own bold coloured dot. The folded line for shell commands now reads `Ran 2 shell commands`, and the launch row of background agents and workflows says to follow the work with `↓` or `/tasks`. The fullscreen view and `namzu watch` use the same mark.
