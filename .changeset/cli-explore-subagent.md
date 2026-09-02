---
"@namzu/cli": minor
---

A sub-agent that can only look.

The `Agent` tool gains `subagent_type: "explore"`: a read-only sub-agent for the delegations a parent makes most — where is X defined, which files reference Y, how does Z work. Its roster is the parent's working set filtered to tools that declare themselves read-only (`read`, `grep`, `glob`, `ls`, the memory and search tools), so it never asks the operator for permission and cannot be handed a `write` through a `role`. The default `general-purpose` is unchanged. The permission review names the type when one is given, and the working doctrine tells the model when to pick each.
