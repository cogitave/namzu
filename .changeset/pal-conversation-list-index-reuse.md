---
"@namzu/cli": patch
---

List Pal conversations with one per-call session-index synchronization instead of reopening and synchronizing the entire index for each candidate. Membership, current workspace identity, pinned revision, tenant, project, exact working directory and archive state remain validated from fresh profile and journal reads before the output limit. Standalone membership checks and ordinary-workspace or alias refusals retain their existing behavior.
