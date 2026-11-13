---
'@namzu/cli': minor
---

In fullscreen mode (`tui.fullscreen`), the mouse wheel glides and speeds up, and the hint for new output counts. What changes on your screen:

- A wheel notch now moves the view over a few frames and lands exactly on three rows; a fast run of notches speeds up to about a window a notch, and a pause or a change of direction returns to the plain step. Notches that arrive together now all count (they were counted once before), each as a plain step: a terminal that sends three reports per notch moves nine rows a notch with the default `tui.wheelRows: 3`, so set `tui.wheelRows: 1` there to move three. PgUp, PgDn, Home, End and a mouse press are still immediate. Switch the speed-up off with `tui.wheelAccel: false`; set the rows per notch with `tui.wheelRows` (1 to 20, default 3) for a terminal that sends several reports per notch. Under reduced motion there is no glide: a notch is one frame.
- While scrolled up, the row above the composer says how many replies came (`2 new replies · ↓ Jump to latest · End`) instead of `New activity`; a reply that only grew says so, and `Reply grew` once it has finished. Counting replies of the model with text only. The hint names End instead of PgDn, and a click on it jumps to the newest row (mouse at `full`). A quiet rule in the transcript marks where the new replies begin until you send your next message.
- The default screen's scroll-back view (PgUp from the composer) shows the same count.

No setting's default changed; the two new keys are in your own config files only.
