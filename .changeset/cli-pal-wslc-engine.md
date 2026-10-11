---
"@namzu/cli": minor
---

`NAMZU_PAL_COMPUTER_ENGINE` accepts `wslc` (Windows' own container CLI) besides `docker` and `podman`, and `NAMZU_PAL_WSLC_BINARY` points at a specific `wslc.exe`. Unset keeps Docker, exactly as before. Any other value still stops the Pal computer with an error, which now reads "must be docker, podman or wslc".
