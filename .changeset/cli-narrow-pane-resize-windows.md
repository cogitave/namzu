---
"@namzu/cli": patch
---

On Windows, the interactive screen now re-measures its terminal every 250 ms, so a
Namzu terminal tab that is narrowed or split redraws to the new width instead of
keeping the width it started with (lines cut mid-word, a message box with its
right edge in the wrong place). Nothing changes on other platforms. The footer
also shortens a Windows path at a backslash and shows the home folder as `~` from
`USERPROFILE`. No option or output format changes.
