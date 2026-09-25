---
"@namzu/sdk": minor
---

`PromptContributionRegistry.unregister(id)` removes a prompt contribution and returns whether it existed. Hosts can revoke instructions when a plugin or other contribution owner is disabled, then register the id again when it is re-enabled.
