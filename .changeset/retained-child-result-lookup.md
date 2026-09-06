---
'@namzu/cli': patch
---

Keep completed delegated results available to `wait_for_task` after the manager
evicts terminal task records. A parent can retrieve the full output retained in
its task ledger, including text omitted from completion notifications, without
launching another child. Results remain restricted to the parent that launched
the task.
