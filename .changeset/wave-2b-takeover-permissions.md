---
"@namzu/cli": patch
---

Preserve existing pattern denies and review rules when permission lists add a whole-tool allow, including mixed table/list spellings in either key order. Resolve file-policy patterns at their originating settings file while resolving tool inputs at the execution working directory.

Prevent grep, glob and directory listings rooted above a denied descendant from exposing it through a broader tool allow. These calls now fail closed as a whole rather than returning a filtered permitted subset; narrow the search path to a safe sibling subtree or read an allowed file directly. An omitted search path is checked as the working directory, and search filters are not used as permission boundaries.
