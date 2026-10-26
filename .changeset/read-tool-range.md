---
'@namzu/sdk': patch
'@namzu/cli': patch
---

`read` no longer prints a backwards "PARTIAL view" banner when the window starts after the last line. It succeeds with a note that the file is shorter than the requested start and how many lines it has, and an empty file says it is empty. Binary or non-UTF-8 content gets a short note with its size and the next step instead of numbered garbage; a caller that matched on the old output needs no change. In the terminal, a summary of a selected range now ends with the pointer to the conversation tools, and only when both are mounted.
