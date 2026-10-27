---
"@namzu/cli": minor
---

`namzu exec` (both modes) and the interactive `namzu` take new per-run flags: `--append-system-prompt <text|@file>` adds standing instructions after the cached part of the prompt, `--allowed-tools` and `--disallowed-tools` add permission layers for the run (a deny in any layer still wins), and `--fallback-model <provider/model[,…]>` sets the models to fall over to, replacing the saved fallbacks for that run. `exec` also takes `--max-budget-usd <amount>`, and the new `limits.costLimitUsd` config key sets a spend limit for interactive, `exec` and `drain` turns; a turn stops with `cost_limit` after the model call that passes it, and a model Namzu has no price for is refused up front in plain words. The row that says a fallback took over now names the model that answered. Nothing changes unless you pass a flag or set the key; `namzu resident` and `namzu drain` refuse the flags they would ignore. See the "Flags for one run" page.
