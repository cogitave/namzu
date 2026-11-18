---
'@namzu/cli': patch
---

`namzu config list` now prints a heading (Choosing models, Limits, Terminal app: look, Command line and the like) over the rows of a group inside a section, and `--json` rows carry `group` and `groupLabel` where there is one. Sections moved: `updates.auto` and `updates.check` are listed under `updates`, `browser.enabled` and `codeAnalysis.enabled` under `tools`, `hypermode` under `agent`, and `profiles` under `terminal`, so `namzu config list --section terminal` no longer shows them. Keys and values are unchanged. The output format and quiet descriptions say they shape commands such as `namzu exec`.

Settings are named for a person, not for the config file: for example *Model for quick tasks* (`smallModel`), *Models for automatic choice* (`routing`), *Spending limit per task* (`limits.costLimitUsd`), *Site permissions* (`browser.sites`), *Terminal notification sound* (`tui.sound`). The old label of a renamed row is still found by search, and no key, value or default changes. The next-conversation apply sentence now ends "Open ones keep what they have." and the terminal app's own rows say "the terminal app starts". The *Check before finishing* row says it is terminal app only.
