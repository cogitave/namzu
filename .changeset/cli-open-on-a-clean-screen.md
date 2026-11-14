---
'@namzu/cli': patch
---

Run `namzu`, leave, and run it again in the same terminal: the second session now opens on a clean screen with the banner at the top (under one blank margin row), instead of stacking under the first session's banner, empty input box and footer. The rows on screen move up into the terminal's scrollback (they are not erased, and the scrollback is never cleared), and when you leave, the input box and footer are taken off the screen while the conversation stays. Fullscreen mode, a session run by the workspaces host and output that is not a terminal behave as before.
