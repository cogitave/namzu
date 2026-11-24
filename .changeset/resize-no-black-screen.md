---
'@namzu/cli': patch
---

Dragging the terminal window edge in fullscreen no longer leaves the screen black until you let go. The clean-slate empty frame is now drawn only after the size has stopped changing for a moment; during the drag the interface keeps repainting at the new size.
