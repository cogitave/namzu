---
"@namzu/cli": patch
---

Restores file-defined sub-agent shadowing: a project agent file named `explore` or `general-purpose` again replaces the matching built-in, using the new `AgentRegistry.replace` instead of `register` now that registries throw on a duplicate id by default (`@namzu/sdk`'s registry-collision convergence). No change from the last published `@namzu/cli` behavior — this restores parity with a regression introduced earlier in this same line of work, before it ever shipped.
