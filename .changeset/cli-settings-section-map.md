---
'@namzu/cli': patch
---

`namzu config list` now prints a heading (Terminal app, Command line) over the rows of a group inside a section, and `--json` rows carry `group` and `groupLabel` where there is one. Sections moved: `updates.auto` and `updates.check` are listed under `updates`, `browser.enabled` and `codeAnalysis.enabled` under `tools`, `hypermode` under `agent`, and `profiles` under `terminal`, so `namzu config list --section terminal` no longer shows them. Keys and values are unchanged. Three labels changed: the update channel, install and check rows no longer repeat "command line", and the output format and quiet descriptions say they shape commands such as `namzu exec`.
