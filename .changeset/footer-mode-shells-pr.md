---
"@namzu/cli": patch
---

The composer footer is now one row of items: the mode in plain words (`⏵⏵ bypass permissions on`, `⏵⏵ accept edits on`, `‖ plan mode on`), a `N shells` pill for running background shells (the separate "shells running" line is gone), and `PR #592` for the current branch's pull request, coloured by review state and linked where the terminal supports it. The pull request comes from the `gh` command line tool, read in the background, only on a real terminal; `NAMZU_PR_STATUS=off` turns it off. The working directory no longer appears on the footer row, and while a turn runs the row says `esc to interrupt`.
