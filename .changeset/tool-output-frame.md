---
'@namzu/cli': patch
---

**Tool output reads cleaner.** Bash results drop their `STDOUT:` / `STDERR:` section labels (the ✓/✗ glyph already signals success), and every collapsible tool block (output, diffs, sub-agent trees) is now framed by a dim left rule `▏`, the way Claude Code / Warp set tool output apart from the conversation.
