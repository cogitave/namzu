---
"@namzu/cli": patch
---

Under WSL, several things now look for Windows programs under the drive mount root set in `/etc/wsl.conf` (`[automount] root`) rather than always under `/mnt/c`: the scheduler service's programs (`schtasks.exe`, `cmd.exe`, `powershell.exe`, …) and the directory they start in, Windows notifications, and the paths the model is told about. On a distro that moved the root, `namzu schedule install` used to refuse and notifications never appeared. On the default `/mnt/` nothing changes. A service installed while the root was elsewhere keeps the program paths recorded in its manifest. If you have since moved the root, reinstall it with `namzu schedule install`.
