---
'@namzu/sandbox': minor
---

Carry explicit Firecracker network intent on the orchestrator create request.
`allow-all`, `deny-all`, and resolved allowlists now have distinct wire shapes;
an absent policy keeps the legacy request unchanged.
