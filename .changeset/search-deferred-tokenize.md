---
'@namzu/sdk': patch
---

Fix `search_tools` failing to load deferred tools when the model names several at once. `ToolRegistry.searchDeferred` matched the entire query as a single substring, so a batched query like `"A2aCard PeerRegister PeerList"` matched no tool and activated nothing — the subsequent call then failed with "deferred and cannot be executed". The query is now tokenized: a tool matches if its name or description contains the whole phrase OR any single term, so a batch activates each named tool.
