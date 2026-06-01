---
'@namzu/sdk': patch
'@namzu/telemetry': patch
---

Make the package-version read bundle-safe. `version.ts` read `../package.json`
via `createRequire(import.meta.url)` at module-init with no guard. esbuild leaves
`createRequire` calls as runtime requires and collapses the dist tree into a
single file, so in a bundle `../package.json` no longer resolves and the read
threw at import time — crashing the whole process on any code path that touches
the SDK runtime (`Cannot find module '../package.json'`). Wrap the read in
try/catch with a `0.0.0` fallback, mirroring the CLI's existing
`readPackageVersion`. Unbundled behaviour is unchanged (real version is read);
a bundled build degrades the cosmetic version string instead of crashing.
