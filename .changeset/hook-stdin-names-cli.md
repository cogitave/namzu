---
"@namzu/cli": patch
---

Hooks started by the terminal, `exec` and the other hosts now receive `transcript_path` (the conversation's saved file) and `permission_mode` (`default`, `acceptEdits`, `plan`, `auto` or `bypassPermissions`) on stdin, beside the new `hook_event_name` and `tool_response` names. No script has to change.
