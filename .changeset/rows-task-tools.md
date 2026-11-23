---
'@namzu/cli': minor
---

Transcript rows for work-status tools are one plain line. `agent_task_list` reads `Checking agents` then how many agents and workflow runs are running; `wait_for_task` reads `Waiting for background work` then `Finished`, `Failed` or `Still running`; `search_tools` names the tools it loaded. The frame that marks a delegated agent's or a fetched page's text is no longer shown in any row, live or after a resume (the model's copy is unchanged). A page fetch row is `Fetch(url)` instead of `Web fetch(url)`, and a hosted search that ran several queries says `Did N searches`. Anything that read the old row text needs the new wording. The same lines now appear after a conversation is reopened, and a workflow or background-command notice that was injected for the model reads as one line (`Workflow <name> finished · 1m 1s · 2 agents`) instead of its raw text.
