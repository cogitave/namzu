---
'@namzu/sdk': patch
---

A command the agent runs in the foreground now gets end-of-file on stdin at once, on every platform, instead of waiting on an input that never came until its timeout. A caller of `spawnHostShell` that needs to feed the child still passes its own `stdio`. The `bash` tool description and its moved-to-the-background message now tell the model the shell has no keyboard, so it uses a non-interactive flag, passes the answer in the command, or asks the person.
