---
"@namzu/sdk": minor
---

A shell hook's stdin JSON now also carries `hook_event_name` (the event in PascalCase, such as `PreToolUse` or `Stop`) and `tool_response` (the same object as `tool_result`), and, when the host supplies them, `transcript_path` and `permission_mode`. The existing names are unchanged, so no script has to change; a script written for another host's hook format reads its own names. `attachShellHooks` and `createShellHook` take two optional options, `transcriptPath(sessionId)` and `permissionMode()`, called at every run; leave them out and those two fields are not sent. A `permissionDecision` of `defer` was already accepted and decides nothing; its error text now lists it. Exit codes are unchanged.
