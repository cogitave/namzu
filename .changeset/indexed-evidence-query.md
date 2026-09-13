---
"@namzu/sdk": patch
"@namzu/cli": patch
---

Fix opt-in evidence query planning failing when a model rewrites a word's
spelling or inflection. The internal planner selects numbered words supplied
by the host; retrieval receives the original spellings after quote validation.
The vocabulary shares the existing 12,000-character preparation allowance,
offers at most 256 distinct spellings, and reports omissions. Each plan still
selects at most 16 words. Literal retrieval remains the SDK default, and the
CLI's existing query-resolution opt-out remains available.

Keep present-state plans from expanding with historical terms. Invalid IDs or
quotes still reject optional preparation instead of weakening source grounding.
Update the CLI Session regression for the internal selection protocol.
