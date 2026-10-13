---
"@namzu/cli": patch
---

The CLI now ships as a code-split bundle, so a launch reads a handful of files instead of about 1,700 modules: `namzu --version` drops from about 49 ms to 36 ms, the terminal's first frame from about 555 ms to 265 ms, and `namzu exec` reaches the model about 120 to 210 ms sooner. The `namzu` bin name and path (`dist/bin.js`), every command, option and output stay the same, and no code needs to change to upgrade.

What to know if you inspect the install: `dist/` holds a few dozen bundled files and chunks plus the type declarations, not one file per source module, so a deep import of `@namzu/cli/dist/...` (never in `exports`) no longer resolves. `quickjs-emscripten-core` and `@jitl/quickjs-wasmfile-release-sync` are now direct dependencies of the CLI, because the bundled SDK finds them by path; they are the same versions the SDK already required. `@namzu/browser`, `@namzu/sandbox`, `@namzu/telemetry`, `@namzu/computer-use` and `node-pty` are still loaded from your install, not bundled.
