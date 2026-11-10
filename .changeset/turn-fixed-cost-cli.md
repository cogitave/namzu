---
'@namzu/cli': patch
---

Starts and turns spend less time before the model is asked. On WSL, launching no longer starts `cmd.exe` four times to find the Windows home (it asks once, and asks again if the answer failed), and `namzu acp` writes Node's compile cache itself two seconds after it starts, so an engine that is killed instead of closed after that still starts warm the next time. Nothing to change on your side.
