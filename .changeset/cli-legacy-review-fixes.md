---
'@namzu/cli': patch
---

A folder whose `.namzu` is the live Namzu home no longer gets a git exclude block or an "earlier Namzu" notice. The notice says git does not list the untracked part, since git still lists tracked files. `namzu state move legacy` across file systems keeps folder modes and times, and `namzu state` counts the home's `legacy/` folder as `legacy` instead of `unknown`. The refusal for `#note` when no stored memory is open no longer says Namzu could not open the folder's saved data.
