---
'@namzu/desktop': patch
---

The "Trust this folder?" dialog now reads every Namzu settings file in the folder, `.namzu/settings.json`, `.namzu/settings.local.json` and the earlier `namzu.config.local.json` as well as `namzu.config.json`, and names the file each finding comes from; when `.namzu/settings.local.json` and `namzu.config.local.json` hold the same settings, they are listed once. The trust-again check covers `.namzu/settings.json` too; a folder without that file keeps the fingerprint it had, and a remembered answer saved to the local file never makes Desktop ask about the folder again. Commit changes leaves Namzu's settings for this computer out and says so.
