---
'@namzu/cli': major
---

`namzu config` no longer lists `permissions.disableBypassMode` as a setting; the key still works in a config file or the managed file and still beats `allowBypassMode`, and `namzu config get permissions.allowBypassMode` notes who turned it off. *Keyword trigger* now names the words `hypermode` and `workflow`, and the helper rows are ordered Dynamic workflows, Keyword trigger, Dynamic workflow size, then the two caps. **Breaking:** `namzu config set permissions.disableBypassMode` is refused now; write `permissions.disableBypassMode: true` in the config file (or the managed file) instead, which works as before.
