---
'@namzu/sdk': patch
---

`edit` now refuses a file that changed on disk after the model read it, with the same message `write` gives, whatever the replacement is. Before, a replacement whose `old_string` still matched uniquely was applied, which could write into a value that had changed (read `a = 1`, file now `a = 100`, replacing `a = 1` with `a = 2` wrote `a = 200`). A caller that relied on the recovery reads the file again and repeats the edit; a host that supplies no read ledger is unaffected.
