---
'@namzu/cli': minor
'@namzu/sdk': minor
---

`/memory` with no arguments now opens a picker of every stored memory of the project, instead of printing the report. Pick one to read or delete it, or delete all the memories turns recorded on their own; each delete asks once more. `/memory delete <name>` and `/memory delete --recorded` do the same by typing. `/memory show` and `/memory list` keep printing the report. A note that starts with the word `delete` now needs `/memory add delete ...`. `@namzu/sdk` exports `memoryOrigin` and `MemoryOrigin`, which say who wrote a memory.
