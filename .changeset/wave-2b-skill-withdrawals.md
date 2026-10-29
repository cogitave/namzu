---
"@namzu/cli": patch
---

Announce skills removed from the model's catalogue, including removal of the final skill. Withdrawals are replayed from conversation history so unchanged turns remain quiet and re-added skills are announced again, including after compaction. Skill bodies still load on demand through the skill tool; no tool deferral is added.
