---
"@namzu/sdk": minor
---

`createComputerUseTool` takes `browserWindows` (`'look'` by default, `'ask'`, `'act'`) and `askBrowserWindow`. With `look` nothing changes: a browser window is only looked at. With `act` the tool clicks and types in browser windows like in any other app. With `ask` it looks until `askBrowserWindow` returns `'allow'` for that browser, then acts there for the life of the tool; with no `askBrowserWindow` it stays look-only. A refused action now tells the model the three ways forward. The tool gains `browserGrants()` and `revokeBrowserGrant(app)`, and `consequence()` also flags accepting, agreeing, posting, publishing, confirming and password or card-number controls. To keep the old behaviour, change nothing.
