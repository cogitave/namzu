---
'@namzu/browser': minor
'@namzu/sdk': minor
'@namzu/cli': patch
---

A browser action that changed nothing visible now says what the page sent. Where the result used to read `Effect: no visible change.` it reads `Effect: no visible change on the page; it sent 1 request.` when the page started `fetch`, XHR or document requests after the action, with the method and path (no query string) of the first three inside the untrusted `web-page-change` envelope. Images, scripts, beacons and other resources are not counted. This lets a model tell a control that only talks to the server from one that does nothing.

`@namzu/sdk` adds the optional `BrowserEffect.requests` and `BrowserEffect.requestCount`; nothing existing changes, and a host that does not set them renders the old sentence. `@namzu/cli` adds one line to the web-task guidance telling the model to carry on with steps that do not depend on one it cannot confirm, and to report the step left. No action is needed to upgrade.
