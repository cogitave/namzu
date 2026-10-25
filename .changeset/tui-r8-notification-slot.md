---
'@namzu/cli': major
---

One Esc on a typed draft no longer clears it. The first Esc shows `Esc again to clear` at the right end of the footer for a second; a second Esc within 800 ms clears the draft, and an Esc after that arms again. Press Esc twice where you pressed it once. A running turn still keeps Esc for interrupting, and Esc on an empty box is unchanged.

The footer's right end is now a notice slot: one passing notice at a time, ordered by priority. The context meter (`N% until auto-compact`) moves from the left items into it and is hidden from a compaction until the next turn starts; the stop-all chord's notices use it too. The update check no longer writes a scrollback row: when a newer Namzu is out, the footer carries `Update available! Run: namzu upgrade` until the next launch.
