---
"@namzu/sdk": major
"@namzu/cli": major
---

Edits now refuse a file whose captured content fingerprint differs from its
current contents, even if the requested anchor still matches. This applies to
local and sandbox edits. Read the changed file again before retrying; unrelated
external changes no longer silently pass edit admission.

The interactive CLI retains file observations across turns of a live agent
session. SDK hosts can share `createFileReadTracker()` through
`query({ fileReadTracker })` across their conversation's turns. Keep trackers
isolated by conversation and filesystem; an omitted tracker remains run-local.
Observations are in memory, not a durable resume record. No atomic exclusion
of external writers after admission is promised.
