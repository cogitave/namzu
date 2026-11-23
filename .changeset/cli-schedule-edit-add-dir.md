---
'@namzu/cli': patch
---

`namzu schedule edit <job> --add-dir <dir>` now adds the folder to the job's stored list; before, it was ignored unless `--permissions` was also given. An edit with `--permissions` that names no list of its own keeps the stored folders instead of dropping them. A permissions file that sets `additionalDirectories` still replaces the list.
