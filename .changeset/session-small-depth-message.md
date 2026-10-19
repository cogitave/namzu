---
"@namzu/sdk": patch
---

The error returned when an agent delegates past the depth limit now ends with an instruction to do the task directly with the agent's own tools instead of delegating it again. The text still begins `Max task depth N exceeded (current: D).`; the trailing sentence about resource exhaustion is replaced. A host that matches on the old trailing sentence should match on the prefix.
