---
"@namzu/cli": patch
---

Teams review fixes: a plain task list no longer shows `waits on` and owners (only a team's list does); a teammate stays "working" on the lead's screen until its `teammate_idle` hook has let it go; a teammate that approved a shutdown leaves a "left the team" row; the plan notice tells the lead it cannot approve the plan; and only a teammate's question, not a sub-agent's, stays open after the lead's turn ends.
