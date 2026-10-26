---
'@namzu/cli': patch
---

Prompt wording. The plan-mode reminder now says why plan mode exists and what is allowed (read and search freely, write only the plan file), asks for approval by calling `exit_plan_mode` because a plain-text question cannot be answered in the approval screen, and no longer says it overrides every other instruction. Coming back into plan mode with a plan for a different task says to write the new plan over the old one, not to start over. The opening line of the system prompt calls Namzu an AI kernel. Nothing to do on upgrade.
