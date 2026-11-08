---
"@namzu/sdk": patch
---

A remembered `approve-all` no longer approves a batch that holds a call a rule or a hook asked a person about (`authorization.askRule`, `authorization.explicitReview`, or a hook permission of `ask`); such a batch goes to the prompt, and a plain yes to it does not set the latch. Before, the latch answered those asks without a person seeing them. Nothing to change in a host: ordinary calls are still answered by the latch.
