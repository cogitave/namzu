---
'@namzu/sdk': patch
---

The coding-agent working rules are shorter and say each thing once. A model now answers a question first and, when one look does not give the fact, says what it looked at and what is missing instead of searching on; it asks only when it cannot name the most likely reading, and asks once with its best guess; it does not issue a refused or empty call again. The coding specifics (reproduce a defect, run tests and lint, finish the whole task) are grouped under a heading that applies when the task is to change code, the closing report of what changed is asked for only when something changed, and narration is one rule (a line before long work and on a finding, none per call). The delegation and status sections are shorter. `CODING_AGENT_WORKING_DOCTRINE` and `CODING_AGENT_DELEGATION_DOCTRINE` keep their names and types; a host that matched on their old sentences sees different wording.
