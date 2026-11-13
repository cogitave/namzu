---
'@namzu/cli': patch
---

The fullscreen view (`tui.fullscreen`) no longer stops with "Namzu stopped because of an unexpected problem" in a window like 80x24 after a reply that holds a code block with a line wider than the window; the same turns at 120x40 had not stopped, because no line was wider than the window. A reply that holds one line of tens of thousands of characters no longer makes the window ignore keys while it streams: a key is echoed in well under a tenth of a second, and the text stays whole for copy and search. Nothing to switch off and no setting changed.
