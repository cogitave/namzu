---
'@namzu/cli': minor
---

The desktop host now answers `namzu/project/untrust`, and the trust store exports `untrustDir(dir)`. They remove only the entry that names the exact folder from `~/.namzu/trust.json` and report an ancestor entry that still covers it as `stillTrustedBy`, so a caller can say the folder remains trusted instead of claiming it was removed. Nothing existing changes: `trustDir`, `isTrusted` and `namzu/project/trust` behave as before, and a host that predates the method is simply not asked. `trustDir` and `untrustDir` now write `trust.json` to a uniquely named temporary file and rename it, so a concurrent reader never sees a partial file.
