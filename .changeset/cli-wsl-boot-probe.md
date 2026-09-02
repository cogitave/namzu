---
"@namzu/cli": patch
---

On WSL, the probe that asks Windows for the paired home directory (to find a Claude credential on the Windows side) now ends with SIGKILL when it overruns its second; the interop shim ignored SIGTERM, and a boot could wait on it indefinitely. The credential discovery step is also bracketed in the debug log with its duration, so a boot that stalls there says so.
