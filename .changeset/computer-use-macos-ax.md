---
"@namzu/computer-use": minor
---

macOS gets windows, window screenshots with window-scoped input, the accessibility controls tree (`ui_snapshot` with refs that survive, `ui_act`), waiting for a window to settle from events, and scroll. They come from "Namzu Helper", a small Swift app that the package builds from its own source the first time it is needed (`swiftc` from the Xcode Command Line Tools, ad-hoc signed, never `sudo`), starts through LaunchServices in your desktop session and talks to over a unix socket under the Namzu home. Accessibility and Screen Recording are then granted once to "Namzu Helper" in System Settings > Privacy & Security, and the adapter says which switch is still off. Without the Command Line Tools, or with `NAMZU_COMPUTER_USE_A11Y=off`, the macOS adapter behaves as before. A caller that listed macOS `scroll` as unsupported now sees it offered when the helper is running. `@namzu/computer-use` now ships `helper-macos/` in the package.
