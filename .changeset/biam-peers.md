---
'@namzu/cli': minor
---

**Cross-terminal agent awareness via clawtool's peer registry (no separate daemon).**

namzu now registers itself as a peer in clawtool's BIAM registry on launch (clawtool is the coordination daemon namzu already discovers — there's no separate `namzu serve`). `/agents` lists every agent peer clawtool knows about across your terminals and LAN — namzu, claude-code, codex, gemini — and `/msg <peer> <text>` sends a message to another peer's inbox. Presence is best-effort: with no clawtool running, namzu behaves exactly as before.
