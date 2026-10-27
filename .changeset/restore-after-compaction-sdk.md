---
'@namzu/sdk': minor
---

A compaction now puts back what a summary cannot carry: the skills the conversation loaded and the files it read, verbatim, under `## Restored after compaction` at the end of the summary. At most 8 skills (5,000 tokens each, 25,000 together) and 5 files (5,000 each, 50,000 together), newest first, capped to 5% and 10% of the window so a small window is not refilled; instruction files and plan files are skipped and a file changed after it was read is left out. The bodies are recorded as tool calls finish in the new optional `WorkingState.restorable` and carried in the working-state snapshot.

A host can carry a line across with the new optional `QueryParams.postCompactionContext` (and `postCompactionContext` on an agent config), asked once per pass, or `CompactNowInput.restoreNote` for a pass it starts itself. Summaries are therefore longer than before when skills or files were used; nothing needs changing to take it. A caller that compares a summary's exact text should expect the extra section.
