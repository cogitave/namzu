---
'@namzu/cli': patch
---

On Windows the background extension runner starts with no console window: the sign-in task and the Run key start it through the script host (`wscript.exe //B //Nologo start.vbs`, which runs the launcher hidden), where they started `start.cmd` and showed a cmd window. The existing task is rewritten the next time the runner reconciles its sign-in entry. `taskkill` is hidden as well.
