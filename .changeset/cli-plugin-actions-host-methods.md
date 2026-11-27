---
'@namzu/cli': minor
---

The desktop host gains methods for adding marketplaces and installing, enabling, updating and removing plugins from the Customize page, under the optional capability group `pluginsManage`: `namzu/marketplaces/preview`, `add`, `list`, `remove`, `update` and `available`; `namzu/plugins/plan`, `stage`, `install`, `enable`, `update_check`, `update` and `uninstall`; and `namzu/ops/cancel`, which stops a long step before anything is written (progress goes out as `namzu/ops/progress`). Nothing is installed on a guess: `plan` returns what the plugin runs, including hook modules and what a remote server would send, with a digest, and `install` refuses any digest but the one shown. `namzu/plugins/list` rows gain `id`, `marketplace`, `layout`, `installed`, `findings` counts and `updateKnown`. Existing callers are unaffected; an older app simply does not offer the group.
