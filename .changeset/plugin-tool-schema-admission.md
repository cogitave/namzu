---
'@namzu/sdk': patch
'@namzu/cli': patch
---

Invalid JavaScript plugin tools now fail when a plugin is enabled, with the
plugin and module named, if they omit a usable `inputSchema`. Before, a
deferred plugin tool could load successfully and then crash the turn with a
Zod `_def` error after `search_tools` revealed it. Supply a Zod
`inputSchema`, or a compatible parser and explicit `modelInputSchema`.
