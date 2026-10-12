---
"@namzu/cli": patch
---

On Windows with the wslc engine, a Pal computer status that cannot be read now reports "not ready" with the setup hint instead of probing the engine, because that probe starts the Linux machine (which may have just been stopped for being idle). Nothing changes for Docker or Podman.
