---
"@namzu/sdk": patch
---

`CODING_AGENT_ORCHESTRATE_DOCTRINE` gains one sentence: agents in the same phase are launched in the same response, with `run_in_background: true` when they are to be waited for together, never one at a time. The text only reaches a prompt when a host turns orchestrate mode on (`codingAgentDoctrineContribution({ orchestrate: true })`); with the option off the rendered doctrine is byte-identical to before. A host that snapshots the orchestrate text will see the new sentence.
