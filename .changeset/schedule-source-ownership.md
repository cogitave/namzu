---
'@namzu/sdk': minor
'@namzu/cli': major
---

Scheduled script jobs can opt out of a project folder with `workspace: none` (`--workspace none` in the CLI). Namzu creates a private working directory only after operator confirmation, and a script never loads that directory as a project configuration.

Interactive schedule proposals now bind noteworthy results to the exact source conversation. The CLI stores them as durable host notices and displays them on resume without adding a fake model turn or changing the model's conversation history. An optional JSON script report lets a polling script distinguish a quiet check from a change and carry a bounded scheduler-owned state value between runs.

The CLI default for newly confirmed interactive proposals changes from detached results to source-conversation delivery. An unavailable source keeps its result pending and holds later runs until delivery succeeds. Existing jobs retain their previous behavior. To keep a new job detached, review `namzu schedule edit <job> --delivery none`; the operator must confirm any exact pending results being waived. New workspace, source-delivery and report fields use job format v3, which older CLIs refuse rather than silently ignore. Upgrade the scheduler service together with the CLI.
