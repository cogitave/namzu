---
'@namzu/cli': patch
---

Harden namzu's anti-fabrication guardrails against relaying another agent's claims as fact. A reply from a tool that delegates to a separate agent (clawtool `agent.run`, an A2A `tasks/send`, a remote peer) is that agent's unverified narrative — it can hallucinate (e.g. claiming a Windows file write when the box is actually WSL2 Ubuntu). namzu is now instructed to treat such replies as claims, confirm them with a deterministic tool (a real shell, a file read) before reporting them as done, and never present another agent's prose as its own verified result.
