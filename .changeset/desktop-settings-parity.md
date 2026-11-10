---
'@namzu/cli': patch
---

The desktop host answers `namzu/config/get` and `namzu/config/set`, so Namzu Desktop can show and change the user config keys. Each write is checked by the loader's own reader before the user file is written, and keys that hold commands or secrets are never read out. Nothing changes for the terminal app or for an existing config file. `namzu/config/set` accepts `dryRun` to check a change without writing it, and both config methods refuse a Pal session.
