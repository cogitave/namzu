---
"@namzu/sdk": minor
"@namzu/cli": minor
---

Add optional exploration presentation metadata to tool call views. The CLI groups consecutive successful file observations while preserving their complete retained output behind Ctrl+O. CLI tool-end events additionally expose retained `output` before preview formatting, so hosts can recover exact text. Background job calls now identify the operation and job. Failures remain visible outside compact groups.

Fix grep returning no matches when its path names a regular file. Local and guest traversal now search that file without enumerating its parent.
