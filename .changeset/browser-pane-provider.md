---
'@namzu/browser': minor
---

New: drive an app's own browser tabs instead of launching a browser. `PlaywrightBrowserHost` takes a `provider` option; `createPaneProvider(channel)` returns one that connects Playwright to the tabs a `PaneChannel` offers (`createPaneTransport` is the piece in the middle), and `host.capabilities.engine` is then `pane`. Without the option nothing changes: the local and Windows browsers open exactly as before. The new exports are `PaneProvider`, `createPaneProvider`, `createPaneTransport`, `refuseOutsideThePane`, `PaneChannel` and its helper types, and the `BrowserContextProvider` interface. `PaneChannel.onClose` is required, so a relay reports a lost link.
