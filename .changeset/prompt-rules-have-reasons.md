---
'@namzu/sdk': patch
'@namzu/cli': patch
---

Prompt wording. The working rules, the identity block and the tool descriptions say what to do and why instead of stacking prohibitions and capitals; a tool-specific rule (changing a file, building a long file, waiting for a job, when to call `workflow`) now lives only in that tool's description, and the workflow opt-in list is in the `workflow` tool's description alone. The evidence rules are three bullets. Every parameter of the browser, conversation, agent-task and loop tools now carries a description, and the `Agent` tool's `prompt` parameter asks for an objective, what is out of bounds, tools and sources, and the reply shape. A host that matched the old sentences in `CODING_AGENT_WORKING_DOCTRINE` or the tool descriptions by text should match the new ones; nothing else changes on upgrade.
