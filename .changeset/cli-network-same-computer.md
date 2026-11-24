---
"@namzu/cli": minor
---

Your other Namzu homes on the same computer (the terminal, a scheduled service, Desktop, WSL) now join your Namzu network without asking you, with one line, "<name> joined from this computer." They prove it with a secret only your OS user can read, `~/.namzu/network/machine-secret`; a home with another `NAMZU_HOME`, another OS user, or a secret that others can read still asks. To be asked for every one, set `network.sameComputer: false` (or `network.autoAdmit: never`). `namzu peers same computer reset` deletes the secret so a new one is made. `/peers` and `namzu peers list` group these homes as "this computer", and a service home is named `<host> (<service>)`.
