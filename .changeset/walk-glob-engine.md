---
'@namzu/sdk': patch
---

The sandbox file walk no longer depends on minimatch 9, which carries GHSA-g3hv-75wg-m249 (denial of service through globparts amplification, fixed only from minimatch 11.0.1). The walk compiles each pattern segment itself, so `glob`, `grep` and `Sandbox.walkFiles` return the same files as before for nearly every pattern; the differences found are: `[ab]/**` no longer lets a root file named `a b.md` through; `@(a|b)*` and `+(a)*` now match the name `a` (and `b`), which minimatch 9 missed; `!(a)*` no longer matches the name `a` and `!(.a)*` with hidden entries included no longer matches `.a`; and `?(a)*` or `*(a)*` no longer match a dot name such as `.env` unless hidden entries are included. An out-of-order range such as `[z-a]` matches nothing rather than failing. `@namzu/sdk` now declares `minimatch` ^11.0.1; nothing you call changes.
