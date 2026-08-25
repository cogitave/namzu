---
'@namzu/sdk': minor
---

Keep final tool results inside `maxToolOutputChars`, including hook replacements and diagnostics, expose the effective cap to tool implementations through `ToolContext.maxToolOutputChars`, and paginate long `SkillTool` instructions with policy-bound continuation cursors instead of irretrievably truncating their middle.
