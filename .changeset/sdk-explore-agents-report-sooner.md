---
'@namzu/sdk': patch
'@namzu/cli': patch
---

The `explore` and `plan` sub-agents' descriptions and prompts now say to return as soon as the question is answered (or the plan can be written), with paths and line numbers, and to name what was not read instead of reading on. When a step of an agent that cannot change anything hits the per-step reasoning cap, it is now told to report what it has instead of to "make the first change", and its next step is no longer forced. Agents that can change files are unchanged. This does not promise fewer requests: in three runs each of four explore agents on a broad mapping task the request count did not change measurably.
