---
'@namzu/cli': patch
---

Match completed tool calls strictly by `toolUseId` in the TUI. The tool-end handler fell back to "the first active tool" when no id matched, which under parallel tool calls attributed a result to the wrong call. Now an unmatched completion renders on its own line and never closes the wrong spinner.
