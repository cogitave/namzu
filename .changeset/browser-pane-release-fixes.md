---
'@namzu/browser': minor
'@namzu/cli': patch
'@namzu/desktop': patch
---

The agent's tab in the Browser pane is no longer closed when the engine's browser is disposed: it lets go and the tab stays for you, so a page you signed in on survives a delegated run, a profile switch or a release. A delegated run under another profile, or a switched profile, uses the engine's own browser, so its cookies stay apart from the pane's. An empty site rule set is now sent when the open request is made, replacing stricter rules an earlier engine left. `signInNotice` takes an optional fifth argument, the place the person signs in (default "the browser window"), and the pane path passes "the Browser pane".
