---
'@namzu/sdk': patch
---

When `search_tools` loads nothing it now says why: the named tool is already loaded (call it directly), it is not available in this session (carry on without it), or no deferred tool matches, in which case the answer adds that a tool not listed under `deferred_tools` does not exist in the session. Before, all three came back as the same "No deferred tools matching" sentence, which models read as "this tool does not exist" and then searched elsewhere.
