---
'@namzu/cli': patch
---

A project file that asks for `permissions.allowBypassMode: true` or `computerUse.enabled: true` no longer makes the Settings row read as on and locked. Those values were already dropped at launch; the row now shows your own value and stays editable. A project's `computerUse.deniedApps` no longer locks the row either, because it adds to your list.
