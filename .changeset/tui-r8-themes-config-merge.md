---
'@namzu/cli': major
---

The `tui` block of the config now merges key by key across your config files; before, a later file that had a `tui` block replaced the whole block. A later file that sets only `notifications` no longer drops an earlier file's `notificationMethod`. If you relied on a later file replacing the whole block, list every key you want in that file (or remove the keys you no longer want from the earlier one) to keep the old result.
