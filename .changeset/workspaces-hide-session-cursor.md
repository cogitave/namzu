---
'@namzu/cli': patch
---

In `namzu workspaces`, the terminal's own cursor is no longer shown over a session. Before, a terminal that showed it (some Windows setups did) drew a blinking bar under the composer, away from where you type; the composer's own caret is unchanged.
