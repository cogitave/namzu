---
'@namzu/cli': patch
---

With `model: auto`, a turn that ends on a provider or model error now makes the next turn in that conversation run one tier up (`fast` to `default`, `default` to `big`), as the routing rules always said; before, nothing told the router the previous turn had failed, so the rule never fired. Your interrupt, a refused permission, a budget or iteration stop, a guardrail and a model declining to answer do not count as a failure, and the escalation applies to one turn only. Nothing to change on your side; a conversation that hits provider errors on `fast` may now spend on `default` for one turn.
