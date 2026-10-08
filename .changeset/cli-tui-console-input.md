---
"@namzu/cli": patch
---

The interactive screen now reads keys from the Windows console input device when `process.stdin` is not a terminal but the output is, which is the case when the CLI runs as Electron's plain-interpreter mode inside a pseudo-console (a terminal started by the desktop application). Before, it stopped with `Raw mode is not supported on the current process.stdin`. An ordinary launch, and every non-Windows launch, keeps `process.stdin`; nothing to change on upgrade.
