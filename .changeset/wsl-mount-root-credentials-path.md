---
"@namzu/cli": patch
---

Under WSL, the Claude, Codex, Gemini and OpenCode sessions you are signed in to on Windows are now found even when `/etc/wsl.conf` moves the Windows drives (`[automount] root`). The paired Windows home used to be looked up only under `/mnt/c`. A scheduled run's `PATH` now also drops the Windows drive entries under that root, instead of only those under `/mnt/`. On the default `/mnt/` nothing changes.
