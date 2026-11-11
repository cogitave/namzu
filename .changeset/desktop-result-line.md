---
'@namzu/desktop': minor
---

A finished turn now ends in one row that says how it went: "Done in 3s", how many files changed and by how much ("4 files +35 −3"), and what the turn's record says about checking, such as "Checked: pnpm test passed". A check that failed shows in red and cannot be missed; a turn that was not checked shows only the counts. Click the row to open the changes. It replaces the "Changed 4 files" card and the sentence under it: Undo, Open file and Copy summary are in the "..." at the end of the row, and "View changes" is the row itself. The fold above an answer now reads "Worked for 3s, 4 steps".

The Changes pane opens wider (520 px, at most half of a small window) on the file that changed most, with a narrow list of files beside the diff instead of above it. Its header is one row: the title, a switch between This reply and All changes (All changes first), the counts, a View menu (split or unified, wrap lines, collapse folders, uncommitted changes, copy paths, expand) and close. The Activity tab is no longer drawn above Changes: open it from Conversation details, then Background work. The top bar's changes button shows the lines added and removed. In a window narrower than 1281 px the sidebar folds to its rail while the pane is open and comes back when you close it, unless you opened or closed it yourself in between.
