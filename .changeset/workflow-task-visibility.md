---
"@namzu/cli": minor
---

Show running workflow agents when the model asks what is still working. Task
inspection and controls now find active workflow children across the same
conversation's scheduler turns, rather than listing only completed siblings.
Model requests also receive current running/queued workflow facts.

Use `agent_task_list` with `task_id` and `include_output: true` to inspect bounded
partial activity without waiting for completion. Listings include reported token
and tool counts, the last tool identifier and workflow/phase identity. Partial
output is marked as delegated data and is distinct from the final task result.
