---
"@namzu/cli": patch
---

The terminal agent's composer is usable as soon as the saved or automatic model is known, instead of after the provider's model list (`GET /models`) answers. With a gateway or local server that answers in 1 second, the composer used to appear 1 second later; now it appears at the same time as with a fast server. The reasoning-effort menu follows when the list arrives; a message sent before then uses the chosen model and the provider's default effort (a launch `--effort` applies once the menu arrives), hypermode pins its effort when the menu arrives, and a list that fails leaves the effort menu out without a message. `namzu exec` and ACP session creation still wait for the list, as before. `AgentSessionOptions` gains an optional `deferEffortCatalogue`; leave it off to keep the old behaviour.
