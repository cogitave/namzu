---
"@namzu/cli": patch
---

A reply taller than the terminal keeps its last line once it finishes. The redrawn part of the screen is now held one row shorter than the terminal, so the renderer no longer clears the screen and replays the session on every frame of a long reply, and no longer erases the reply's final line when the turn settles. While such a reply streams, its newest rows stay on screen; the whole reply reaches scrollback when it ends.

A list item or blockquote containing a pipe directly under a markdown table is drawn as a list item or quote again, not as an extra table row.
