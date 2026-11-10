---
'@namzu/sdk': patch
---

The sandbox file walk no longer depends on minimatch 9, which carries GHSA-g3hv-75wg-m249 (denial of service through globparts amplification, fixed only from minimatch 11.0.1). The walk compiles each pattern segment itself, so `glob`, `grep` and `Sandbox.walkFiles` return the same files as before for the pattern forms they accept; the one difference found is that `[ab]/**` no longer lets a root file named `a b.md` through. `@namzu/sdk` now declares `minimatch` ^11.0.1; nothing you call changes.
