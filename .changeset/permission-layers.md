---
"@namzu/cli": major
---

The `permissions` tables of your config files are now combined instead of replaced, and a deny in any of them wins. This is a changed default, so it is a major.

What changed: a `permissions` table in `namzu.config.json` used to replace every key of the user's `~/.namzu/config.yaml` table, and the managed file replaced the table of everything below it, so a project could erase your `bash = { "git push*" = "deny" }`. Now the user, project, selected-profile and managed tables all apply. Each layer decides on its own by the rules it always had (most specific pattern first inside one table); then a layer that denies the call denies it, else a layer that asks asks, else a layer that allows allows. Which layer is higher no longer changes the outcome.

What breaks: a rule that was hidden because a higher file wrote its own table applies again. A call a lower file denied or asked about, and a project or managed table used to allow by overwriting it, is now denied or asked. There is no way to switch a lower layer's deny off from a higher layer; delete the rule from the lower file. The old behaviour (the highest table alone) cannot be kept by a setting; put every rule you want in the one file that should decide.

Loaded configs carry a new `permissionLayers` list beside `permissions` (now the combined view); a file that writes `permissionLayers` is refused. Hosts that compile `config.permissions` themselves should call `compilePermissionLayers(permissionLayersOf(config), config.permissionChecks)` instead.
