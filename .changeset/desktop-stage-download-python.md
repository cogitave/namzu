---
"@namzu/desktop": patch
---

Staging an installer without a cached Python archive no longer fails at its last step. Before this fix it downloaded Python, copied it, deleted the download, and then failed trying to measure the deleted file. The release workflow stages that way.
