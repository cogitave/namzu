---
"@namzu/cli": patch
---

The terminal app now draws in a terminal even when `CI` or similar variables are set in the shell (dev containers, inherited terminal tabs); before, the screen stayed blank until exit. The variables are not changed for the commands the agent runs. Nothing to do on upgrade.
