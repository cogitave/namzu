---
'@namzu/cli': minor
'@namzu/sdk': minor
---

`/memory` with no arguments now opens a picker of every stored memory of the project, instead of printing the report. Pick one to read or delete it, delete all the memories turns recorded on their own, or delete every memory of the project; each delete asks once more. `/memory delete <name>`, `/memory delete --recorded` and `/memory delete --all` do the same by typing. The curated `MEMORY.md` and `USER.md` are never deleted this way. `/memory show` and `/memory list` keep printing the report. A note that starts with the word `delete` now needs `/memory add delete ...`. `@namzu/sdk` exports `memoryOrigin` and `MemoryOrigin`, which say who wrote a memory.
