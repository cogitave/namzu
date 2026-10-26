---
'@namzu/sdk': minor
---

The "Approval policy changed from X to Y" notice now reaches the model as request-only context after the conversation, not as a system message ahead of it, so a mid-conversation change no longer changes the prefix a prompt cache keys on. Add `announceApprovalPolicyChange: false` to `query()` if your host already tells the model about the change itself; the default (`true`) still tells it once, and the `approval_policy_changed` event is recorded either way. Nothing to change unless you read that notice out of the system messages.
