---
'@namzu/sdk': minor
'@namzu/cli': patch
---

Plan mode now refuses a change that a permission rule allows. Before, a batch whose every call a rule allowed (for example `permissions: { bash: 'allow' }`) ran without reaching the review handler, so a turn in plan mode, whether it started there or the operator entered it with Shift+Tab mid-turn, still ran `touch` or any other allowed command, while the model had been told that every change is refused. The CLI now asks the kernel to send such batches to review while it is in plan mode; nothing changes in any other mode.

For SDK hosts: `QueryParams.reviewAllowedCalls?: () => boolean` is new and optional. Read once per batch; `true` sends a batch a rule allows, or a grant from earlier in the turn covers, to `resumeHandler` instead of running it, each call carrying the gate's decision in `authorization`. A rule's `deny` still refuses. Absent, behaviour is unchanged.
