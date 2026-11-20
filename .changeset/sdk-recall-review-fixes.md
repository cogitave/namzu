---
'@namzu/sdk': minor
---

New export `historyContentShed(messages)`, which says whether the conversation has lost content (a compaction summary, a cleared tool result, or a tool result cut at storage that points at the file holding the rest). A history lookup now treats a clipped tool result as shed content, so its pointers appear and the planner runs. A focus word past the 16-word allowance is dropped with its word instead of failing the plan, a question that points at a different earlier reply ("the first answer") still goes to the planner, and the planner's repeated-key repair looks only at the plan's own keys. The operator log line for a rejected lookup carries a reason code and no error text. Scratch-folder links are replaced atomically and dangling ones removed. Nothing a caller does has to change.
