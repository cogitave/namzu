---
'@namzu/computer-use': patch
---

The Windows desktop driver Namzu downloads is now cua-driver 0.38.0 (it was 0.28.2): a 36 MB archive for x64 or 33 MB for arm64, checked against the hashes pinned in the package as before. The first `initialize()` on a machine that has the old copy fetches the new one into `<NAMZU_HOME>/computer-use/cua-driver/0.38.0/`; the old folder is left where it is and can be deleted. The window UI tree is now read with the driver's `full_output` flag, because 0.35 stopped returning the structured element list unless asked. Nothing to change in your code.
