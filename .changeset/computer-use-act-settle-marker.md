---
'@namzu/computer-use': patch
---

After `ui_act` on a control, the wait for the window to settle now counts from a change marker taken just before the action, as it already did for a coordinate input. Until now only coordinate inputs took the marker, so a control action fell back to the tool's fixed 500 ms pause even with the accessibility host up. Nothing changes for a caller: the pause is shorter when the window stops changing sooner, and unchanged when the host is off or fails.
