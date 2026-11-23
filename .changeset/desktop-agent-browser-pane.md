---
'@namzu/desktop': patch
---

The agent now browses in a tab of the Browser pane, where you can watch it and sign in yourself, instead of a separate browser window. A new setting, *Where Namzu browses* (Settings, Tools, next to *Keep cookies*), chooses between *In the built-in browser* (the default) and *In its own window*; it reaches a project the next time it opens. If the pane cannot be used, Namzu opens its own browser as before and says so. The agent's tab is dropped when its engine restarts and closed when the conversation is removed.
