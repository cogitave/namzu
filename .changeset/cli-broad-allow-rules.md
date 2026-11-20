---
'@namzu/cli': major
---

`accept-edits` now asks about an in-place `sed` that carries a backup suffix (`-i.bak`), `-e`, `-n`, several scripts or a line command; `sed -i 's/old/new/' file` on a path in the working folders still runs without asking. `namzu doctor` has a new `runtime.permission-allow-rules` row, and each run warns once, when an allow rule allows any program: `Bash`, `Bash(*)`, an interpreter, shell, wrapper, launcher or network tool with nothing narrower after it, such as `Bash(python *)` or `Bash(bash -c *)`. The warning names the rule, its file and a narrower one to write instead. Rules keep matching as written; nothing is removed.
