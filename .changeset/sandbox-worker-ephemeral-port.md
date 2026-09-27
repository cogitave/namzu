---
"@namzu/sandbox": patch
---

Workers started with `NAMZU_SANDBOX_PORT=0` now report the actual bound port in their startup log, so callers can connect to the ephemeral listener.
