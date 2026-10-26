---
'@namzu/sdk': patch
---

Compaction summary. The summary now ends with an `## Open Items and Next Step` section (assistant notes that say what is still to do, filed apart from the narration), marks the newest operator request as `Latest request:` in its requirements list, and drops a note that only says the code was looked at. The summary check asks for unresolved errors, open questions, open items and the exact names, values and commands the next step needs, and to list everything missing. Anything that parses the summary by its section headings keeps working; there is a new heading to expect. Nothing to do on upgrade.
