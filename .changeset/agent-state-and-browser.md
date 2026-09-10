---
"@namzu/cli": minor
"@namzu/sdk": patch
---

CLI adds agent_task_list for the invoking run's delegated work, separate from planning tasks. Budget-stopped child results are reported as incomplete rather than successful completion; notifications explicitly distinguish lifecycle termination from task success. The agent browser uses the terminal height and preserves the main draft while its composer is hidden.
