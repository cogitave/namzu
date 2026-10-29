---
'@namzu/cli': minor
---

`/permissions` can now show and edit rules. `/permissions rules [allow|ask|deny]` lists each rule with the file it comes from, `/permissions add <allow|ask|deny> <rule>` and `/permissions remove <rule>` change `namzu.config.local.json` (applied the next time Namzu starts), `/permissions denied` lists the calls auto mode refused in the conversation, and `/permissions dirs` lists the folders the file tools can reach. Bare `/permissions` still opens the mode menu. Nothing to change to keep working.
