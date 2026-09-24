---
"@namzu/cli": major
---

The multi-agent session mode is now called **hypermode**. Turn it on with `/hypermode on` (or pick the last stop of the `/effort` picker, which now reads `xhigh + hypermode (workflows)`, with `Off · delegates to parallel agents by default` under it). The footer shows `· hypermode` and the message box's border names it the same way. **One behaviour change:** the mode now pins reasoning effort to `xhigh`, not to the highest level the model publishes. On a model that offers `max` (or `ultra`), turning the mode on used to select `max`; it now selects `xhigh`, which spends less per turn. A model without `xhigh` gets the highest level it publishes below it, and the stop names that level (`high + hypermode (workflows)`). To run a hypermode session at `max`, turn the mode on and then choose `/effort max`; the mode keeps delegating by default. Independent work is still delegated to parallel agents by default, for this session only.

`/orchestrate` still works: it prints `/orchestrate is deprecated: the mode is now called hypermode. Use /hypermode; /orchestrate will be removed in a later major version.` and then does exactly what `/hypermode` does. Switch any scripts, notes or muscle memory to `/hypermode` before the next major version. The mode was never stored in a config file, so there is nothing to migrate.
