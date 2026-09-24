---
"@namzu/cli": minor
---

The multi-agent session mode is now called **hypermode**. Turn it on with `/hypermode on` (or pick the last stop of the `/effort` picker, which now reads `xhigh + hypermode (workflows)` — the level named is the highest your model publishes — with `Off · delegates to parallel agents by default` under it). The footer shows `· hypermode` and the message box's border names it the same way. What the mode does has not changed: effort pinned to the model's highest level, and independent work delegated to parallel agents by default, for this session only.

`/orchestrate` still works: it prints `/orchestrate is deprecated: the mode is now called hypermode. Use /hypermode; /orchestrate will be removed in a later major version.` and then does exactly what `/hypermode` does. Switch any scripts, notes or muscle memory to `/hypermode` before the next major version. The mode was never stored in a config file, so there is nothing to migrate.
