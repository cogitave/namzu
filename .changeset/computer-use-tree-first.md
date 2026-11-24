---
"@namzu/computer-use": minor
---

The Windows controls tree shows more before it is cut: a window is returned whole up to 400 controls (was 220), an outline lists about 300 (was 150) and 20 children per element (was 12). `ui_snapshot` accepts `role` to keep only controls of a type, read from the whole tree so a match is not lost to the outline, and the adapter reports a control's `focused` state and the window's selected text when the driver sends them. A caller that relied on the old outline size sees longer snapshots.
