---
'@namzu/cli': patch
---

Fix the blank band left at the top of the transcript after scrolling up. Opening the scroll view grows the live frame to nearly the full screen; the frame was repainted in place with no reprint, and because the live region is bottom-anchored the newly claimed rows at the top were left unpainted. The transcript is now cleared and reprinted on the open transition, the same way it already was on close, and a height change while scrolled rebuilds too.
