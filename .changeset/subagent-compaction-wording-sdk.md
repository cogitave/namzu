---
'@namzu/sdk': patch
---

The summary a compaction leaves reads more plainly. The files list gives one line per file, the path then what was done to it ("read; changed"), instead of repeating "read: read". The heading for details the summary check adds is now `## Missing Details`, and the newest request is restated under `## Current Goal` (the task when nothing newer was asked) just before the open items; the `Latest request:` prefix inside `## User Requirements` is gone. The `edit` tool's description now gives the reason for its 12000 character budget. A host that matches these headings in a summary should read the new names; the saved working state itself is unchanged.
