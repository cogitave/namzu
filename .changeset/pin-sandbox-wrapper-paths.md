---
'@namzu/sdk': patch
---

Probe local sandbox wrappers through the same direct child-process and stdout boundary used for execution, then pin the verified canonical absolute wrapper path. Hosts where a wrapper is reachable only through a shell now fall back honestly, and per-run `PATH` overrides can no longer replace a verified isolation wrapper.
