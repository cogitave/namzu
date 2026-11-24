---
"@namzu/sdk": minor
---

`createComputerUseTool` takes `browserWindows` (`'look'` by default, `'ask'`, `'act'`) and `askBrowserWindow`. With `look` nothing changes: a browser window is only looked at. With `act` the tool clicks and types in browser windows like in any other app. With `ask` it looks until `askBrowserWindow` returns `'allow'` for that browser, then acts there for the life of the tool; with no `askBrowserWindow` it stays look-only. A refused action now tells the model the three ways forward. The tool gains `browserGrants()` and `revokeBrowserGrant(app)`, and `consequence()` also flags accepting, agreeing, posting, publishing, confirming and password or card-number controls. To keep the old behaviour, change nothing.

`browserWindows` may also be a function, read at every call; a switch to `look` clears the grants. In a browser the tool refuses `type_text` while the focused control of the latest `ui_snapshot` is a password field, and `ui_act` `set_value` on one. Browser process names (`brave-browser`, `msedge`) read as Brave, Microsoft Edge in questions and rows. The wider consequence words (accept, agree, post, publish, confirm, password, card number) apply to every application, so Desktop may show an ask-every-time card for a control named so in any app.
