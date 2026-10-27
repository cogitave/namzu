---
'@namzu/sdk': minor
---

Add `PLAN_AGENT_ID`, `PLAN_AGENT_DESCRIPTION` and `PLAN_AGENT_PROMPT`: the identity and brief of a read-only delegate that returns a step plan with the files to change and the risks. A host builds its roster the way it builds the `explore` one (each toolset filtered with `isTrustedReadOnly`). `DEFAULT_RESERVED_AGENT_NAMES` is unchanged, so an agent file named `plan` still loads.
