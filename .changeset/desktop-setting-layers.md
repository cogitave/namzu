---
'@namzu/desktop': patch
---

Settings: a row now says when something other than your own file decides its value. When an environment variable, the project's config or your administrator's file sets a setting, the row shows that value, turned off, with "Set by an environment variable (NAMZU_X)", "Set by this project" or "Set by your administrator". In Models, a provider with a key in the environment and a key saved in Settings says the environment key is used.
