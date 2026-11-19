---
'@namzu/desktop': patch
---

The Session panel keeps its numbers across a restart. A reopened conversation shows the context figure its log last recorded (marked as from the last reply), or an estimate from its stored messages where the model's window is known, and the context ring fills at once. The Environment section now always leads the panel: This computer, the folder with a shortened path, and the branch when there is one. A chat shows its own folder as "Chat folder" with no branch.

Window and interface state (layout, panes, collapsed sections, panel tabs, whether a window was maximized or full screen) now lives in one file in the app's data folder instead of the page's local storage, so it survives anything that clears the page's storage and is restored before the first paint. Your existing saved layout is copied in on the first start after the update. After a crash the last checkpoint is restored and a conversation's open panel tab starts over.
