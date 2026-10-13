---
"@namzu/cli": patch
"@namzu/browser": patch
---

The interactive terminal and `namzu exec` start about 150 ms to 250 ms faster. They no longer import `@namzu/sandbox`, `@namzu/browser`, `@namzu/telemetry` and the browser engine just to learn that those packages are installed; the launch-time capability line now reads the packages' manifests, and `@namzu/browser` loads `playwright-core` on the first browser launch instead of when it is imported.

One consequence: a capability package that is installed but fails to load is no longer reported at launch (the `namzu.capability.broken` row). It surfaces where the package is first used, and `namzu doctor` still imports each package and reports it. `probeOptionalPackage` takes an optional `{ load: false }` for the manifest-only answer, and `probeCapabilities` uses it by default; nothing a caller of either passed before changes.
