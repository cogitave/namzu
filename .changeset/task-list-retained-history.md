---
'@namzu/sdk': patch
---

Clarify that task_list returns open tasks and tasks closed in the current turn,
with earlier completed or failed tasks retained in storage but omitted. Its
output now reports retained omissions and distinguishes a filtered empty view
from finding no records; the human presenter also qualifies its counts. Task
selection, input and data.stats remain unchanged. Hosts needing all durable
records should read their authorized TaskStore rather than infer deletion from
this filtered tool result.
