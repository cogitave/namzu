---
'@namzu/cli': major
---

One Esc on a typed draft no longer clears it. The first Esc shows `Esc again to clear` at the right end of the footer for a second; a second Esc within 800 ms clears the draft, and an Esc after that arms again. Any other key between the two ends the window, so typing after the first Esc starts over. The cleared text goes into the prompt history, so Up brings it back. Press Esc twice where you pressed it once. A running turn still keeps Esc for interrupting. On an empty box Esc has its own meaning, described in the rewind note: Esc twice opens the rewind dialog.

The footer's right end is now a notice slot: one passing notice at a time, ordered by priority. The context meter (`N% until auto-compact`) moves from the left items into it and is hidden from a compaction until the next turn starts; the stop-all chord's notices use it too. The update check no longer writes a scrollback row: when a newer Namzu is out, the footer carries `Update available! Run: namzu upgrade` until the next launch.
