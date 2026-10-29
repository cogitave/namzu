---
'@namzu/cli': minor
---

The `@` list in the composer now also offers sub-agents and the resources your connected tool servers publish, beside files. Pick `reviewer (agent)` (or type `@agent-reviewer`) to point the model at that agent; pick a `server:address` entry to send that resource's text with the message. Servers set to ask for approval before use are not offered, and a resource the server did not list is never read. Nothing changes for file mentions.
