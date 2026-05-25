---
'@namzu/cli': minor
---

**Define sub-agents on the fly.** The `Agent` tool now takes an optional `role` — a system prompt describing a specialist persona (e.g. "You are a security auditor; flag vulnerabilities and rate severity"). namzu spins up a fresh sub-agent with that role at runtime, no pre-defined agent file needed; omit `role` for a general-purpose one. Call `Agent` several times in one turn (each with its own `role`) to fan out a parallel swarm of specialists. The persona is layered on top of namzu's anti-fabrication guardrails so a dynamic role can't opt out of "don't invent results".
