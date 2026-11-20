---
'@namzu/sdk': major
---

In `accept-edits`, an in-place `sed` now runs without asking only as `sed -i [-E|-r|--posix] 's/old/new/[flags]' file...` on literal paths inside the roots. Before, `-i` with any attached backup suffix (`-i.bak`, `--in-place=/elsewhere`), `-e`, `-n`, `;`-joined scripts, other delimiters and line commands such as `3d` were also approved; a backup suffix named a second file nothing checked. Those are now asked about. To keep a call from asking, write it in the one form above, or add an allow rule for it. `sed` without `-i` and the other file commands are unchanged.
