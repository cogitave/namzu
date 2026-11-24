---
"@namzu/sdk": minor
---

`computer_use` `ui_snapshot` now reads a window you have read before as what changed since (`+` added, `~` changed, `-` gone, or "no change"), where it used to list the whole tree again. Every earlier ref still works; pass `full: true` to get the whole tree back, which is what to do if your own code parsed repeated snapshots as complete. New `role` field lists only controls of a type (such as `Button`), beside `query`; the result ends with the focused control and any selected text (`UiSnapshot.selectedText`, `UiSnapshotOptions.role` are new on the host contract); the listing cap rises from 14 000 to 24 000 characters; and the first window screenshot of an unread window carries its controls, so a snapshot id (`u1`) may now come from a screenshot.
