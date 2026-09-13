---
'@namzu/sdk': patch
---

Resource-limit closure and recovery from an empty assistant completion now ask for a concise evidence-supported response that attributes unverified claims and identifies unresolved work. The closing request no longer demands a comprehensive answer regardless of the available evidence. This changes the kernel's model guidance, not its factual validation guarantees, tool restrictions, resource limits or stop reasons. The instruction remains local to the closing request and is not retained as an instruction for resumed turns.
