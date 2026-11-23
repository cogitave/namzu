---
'@namzu/browser': minor
---

New: `PlaywrightBrowserHost` takes a `preferredProvider`, a provider tried before the host's own browser. If it cannot be opened (a desktop app with no window to show a tab in, a tab another tool holds), the next result carries one line saying so and the host opens its own browser exactly as it did before; nothing changes for a host that is not given one. `host.where` (`pane`, `own` or `unknown`) and `host.prefersPane` say where the browser runs, and with a preferred provider the host no longer reports its own browser as unavailable before the first call, so a computer with no browser installed can still use a provider's.
