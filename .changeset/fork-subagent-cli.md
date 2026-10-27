---
'@namzu/cli': minor
---

The `Agent` tool gains `subagent_type: "fork"`: a worker that starts from the conversation that launched it, under the same system prompt, on the same model, with the same tools as any sub-agent, and returns one report like other children. Write only the directive as its prompt; do not pass `model`, `provider`, `effort` or `role` (the call is refused). A fork cannot start forks or sub-agents, and a launch is asked about like a general-purpose agent. A project agent file named `fork` still replaces the built-in.
