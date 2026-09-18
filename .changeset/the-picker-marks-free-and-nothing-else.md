---
'@namzu/cli': patch
---

The model picker marks a row `(free)` only when the provider reported both rates as zero, and says nothing about a model whose rate nobody published.

Both halves are the fix. Reading `0` as free is right, and it is now readable: `ModelInfo`'s two price fields are optional, so a driver with no rate omits them rather than writing the zero that made every paid model on four provider menus look free.

The catalogue block under `agent_models` prints a price fact: the rates when the driver published them, `Free` when it reported zero, and `Price unknown` when it published nothing. `Price unknown` is the rendering that did not exist — had absence been given the obvious one it would have printed `$0.00`, which is the same sentence as `Free` to a reader.

The `(free)` marker also survives a narrow terminal. `Picker` rebuilds a row's notes from a fixed vocabulary under 70 columns and drops any word missing from it, so `(free)` had to be added there or it would have been silently discarded on exactly the screens where the row is hardest to read.
