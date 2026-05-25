---
'@namzu/cli': minor
---

**Tool calls now show their diff / output, collapsible with Ctrl+O.**

When namzu edits or writes a file, the change is shown as a `- old` / `+ new` diff (write shows the content) right under the `⏺` call. When it runs a command or reads a file, the output appears under the `⎿` result. Long blocks collapse to 6 lines with a `… +N lines (ctrl+o to expand)` hint; **Ctrl+O** toggles full expansion for everything. Diff lines are colored (green additions, red removals).
