---
"@namzu/cli": patch
---

The terminal agent's composer is usable as soon as the saved or automatic model is known, instead of after the provider's model list (`GET /models`) answers. With a gateway or local server that answers in 1 second, the composer used to appear 1 second later; now it appears at the same time as with a fast server. The reasoning-effort menu follows when the list arrives; a message sent before then uses the chosen model and the provider's default effort, and a list that fails only leaves the effort menu out. `namzu exec` and Desktop still wait for the list, as before. `AgentSessionOptions` gains an optional `deferEffortCatalogue`; leave it off to keep the old behaviour.
