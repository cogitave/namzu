---
'@namzu/cli': patch
---

**Fix the long-session out-of-memory crash and the banner that drifted down the screen.**

The transcript used to re-render its entire history on every frame (each spinner tick and streamed token), so a long conversation grew the render tree until Node aborted with a 4 GB heap out-of-memory. Finalized messages now render through Ink's `<Static>` — each line is printed to scrollback exactly once and never re-rendered — so memory and per-frame work stay bounded and the flicker is gone; only the in-progress reply stays live.

The same change pins the header: because `<Static>` output is written above the live region, the banner (logo + provider + cwd) used to slide downward as messages accumulated. It is now the first static row, anchored to the top of the conversation.
