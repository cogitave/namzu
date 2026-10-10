---
"@namzu/sandbox": patch
---

In a Kubernetes terminal, keystrokes typed right after a resize now reach the program after the new window size does. Before, the resize was applied by a separate process that could finish after the input was written, so a command such as `stty size`, or a full-screen program's first redraw, could report the old size, depending only on how busy the pod was. Input sent while no resize is pending is written immediately, as before.
