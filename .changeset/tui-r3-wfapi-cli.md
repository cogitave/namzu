---
'@namzu/cli': minor
---

Workflows: a standalone `+500k` (or `+1.5m`, `+2b`; the k, m or b is required) in a message you type is now the turn's token target; a workflow started in it sees it as `budget.total` and its `agent()` calls throw once that many tokens are spent. The new `workflow.sizeGuideline` setting (`small`, `medium`, `large`, `unrestricted`; default `medium`) tells the model how large a workflow to write, and a running workflow past 25 agents or 1.5 million tokens now shows `Large workflow · /workflows to stop` on the agents rail unless hypermode is on (`NAMZU_WORKFLOW_SIZE_WARNING_AGENTS` and `NAMZU_WORKFLOW_SIZE_WARNING_TOKENS` change the thresholds). The default workflow limits are now 16 agents at once and 1000 per run; set `workflow.maxConcurrency` and `workflow.maxAgents` to keep the old 8 and 200. Scripts written for the old `pipeline()` stage order must swap the 2nd and 3rd parameters (see the SDK release).
