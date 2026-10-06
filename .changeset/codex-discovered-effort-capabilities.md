---
'@namzu/cli': patch
---

Fix installed Codex conversations rejecting effort choices offered by their native model catalogue. SDK admission now receives the discovered effort capabilities; dispatch still checks each selection against the current selected model before sending a native turn.
