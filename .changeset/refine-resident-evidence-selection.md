---
"@namzu/sdk": minor
"@namzu/cli": patch
---

Improve automatic resident evidence selection when a long objective/summary
loses its subject or frequent matches hide a rarer requested observation.
Selection samples both ends of bounded fields and can spend existing search
pages on uncovered query words. Original and corrected observations retain
separate provenance; ambiguous references are not silently resolved.

Disk evidence sources and the resident source factory now advertise
`supportsTermRefinement`. SDK callers can supply `refineTerms` with an existing
token-search cursor to branch a strict subset at its authenticated position.
Returned cursors use the subset; the original broad cursor remains valid.
Scope, filters, read ceilings and automatic page/context limits stay enforced.
Custom sources without this capability use a fresh subset search; the resident
factory restarts within the selected invocation when its resolved backend
cannot refine a cursor.
