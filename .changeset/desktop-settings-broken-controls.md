---
'@namzu/desktop': patch
---

Settings no longer pretend. Number boxes show their range, take minutes and seconds for times (5m, 90s) and 786k or 1m for sizes, and their hints fit the box. Rows that warn about a risky choice ask only for that choice (default permission mode, web search, memory with a model, refusal handling), and saving what a setting already holds never asks. Rows that live in the config file name the file. Updates says "Not checked yet" before the first check and "Last checked" keeps counting while the page is open. Removing a project now also clears this app's own record of the folder, and the dialog says so. The wait-for-a-busy-provider row sits with the agent rows, the update channel row says it is the command line's channel, and the plugin-folders row that could never be saved is gone.
