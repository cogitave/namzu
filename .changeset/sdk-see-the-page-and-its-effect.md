---
'@namzu/sdk': minor
---

The `browser` and `browser_act` tools carry the page's effect back to the model. A `browser_act` result starts with `Effect:` (the host's own counts, and `no visible change` when a click did nothing), followed by the lines that appeared or went inside the untrusted envelope. `browser` gains `snapshot` fields `view` (`full`, `interactive`, `reading`, `delta`), `query` and `role`, `wait_for` `stable`, and a read-only `value` action; the new types are `BrowserEffect`, `BrowserValue` and `BrowserSnapshotView`, with `BrowserResult.effect` and `.value`, `BROWSER_FIND_MAX_MATCHES` and `renderBrowserEffect`. A custom `BrowserHost` keeps working unchanged: it need not return an effect, and need only handle `value` if it lists it among its actions. `wait_for` with nothing to wait for is now refused with a message that names `stable` too.
