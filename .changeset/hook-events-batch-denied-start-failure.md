---
'@namzu/sdk': minor
'@namzu/cli': minor
---

Four new hook events, available to the `hooks` config and to plugins: `post_tool_batch` (once per model step, after every tool call of the step has settled; carries each call and what the model was given for it; a hook answering `continue: false` ends the turn once the step is done), `permission_denied` (a call refused by a rule, the mode's policy, a classifier or a hook; never one a person declined), `subagent_start` (a delegated child's turn begins) and `turn_failure` (a root turn failed; not for a cancellation). Shell hooks receive them with the names `PostToolBatch`, `PermissionDenied`, `SubagentStart` and `StopFailure` in `hook_event_name`. `PluginHookEvent` and `ShellHookEvent` gain these members, so a `switch` over them that has an exhaustive `never` check needs four more cases. Nothing to change to keep working.
