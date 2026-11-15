---
'@namzu/sdk': patch
'@namzu/cli': patch
---

Read-only sub-agents (`explore`, `plan`) return sooner. Their description and prompt now say to return as soon as the question is answered, with paths and line numbers, and to name what was not read instead of reading on. An agent whose tools only read is reminded once, after 8 steps of looking, to report what it has (a message only: nothing is forced, and it may look on for a gap it can name; `reasoning.stall.lookBudgetSteps` changes the count and `0` turns it off). When such an agent's thinking for a step hits the per-step cap it is now told to report, not to "make the first change", and its next step is not forced. Agents that can change files are unchanged.
