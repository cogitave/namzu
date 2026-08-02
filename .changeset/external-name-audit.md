---
'@namzu/sdk': patch
'@namzu/cli': patch
---

namzu takes its naming from nobody, and now there is a gate that proves it.

`scripts/audit-external-names.mjs` refuses a third-party product name in a
comment or an identifier, and runs in CI. It found 31 real ones — most of
them in the TUI, where the design was being explained as "modelled on how X
presents text", "X-style grouping", "like X / Y".

That is the failure the rule exists for. A design explained by reference to
somebody else's product has handed over its rationale: the next reader
reaches for that product's model instead of asking what namzu is trying to
achieve, and when the reference changes the comment becomes a claim nobody
can check. Each one now states the same decision on its own terms — what it
accomplishes, and what breaks without it.

The kernel had eleven, all in prose explaining a wire behaviour by naming
the vendor whose endpoint exhibits it. A 400 for an unanswered `tool_use`
is a property of the protocol, not of a company; several function-calling
endpoints report `stop` alongside populated tool calls, and which ones is
not the point.

The identity prompt named the products it told the model not to be. It now
says the stronger thing without them: the underlying model is an
implementation detail of how namzu runs, not who it is.

What the audit deliberately does NOT flag, because a rule that cries wolf
gets switched off: wire values and the files that carry them. A
context-window table keyed by model id must contain real model ids or it
resolves nothing; a driver package is named after the service it drives.
The exemption is per path and narrow, and the script says where the line
falls. Scanning string literals was tried and rejected in the same spirit —
it flagged driver ids in switch statements and model ids in test fixtures
everywhere, which would have meant exempting half the tree.

Two matcher details worth keeping: the camelCase check is case-SENSITIVE,
because an `i` flag turns `[A-Z]` into `[A-Za-z]` and the rule starts
rejecting `coherent` for `cohere` and `strands` for the English verb. And
`cursor` is absent from the list entirely — it collides with the pagination
cursor this codebase threads through every list call.
