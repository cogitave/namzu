---
'@namzu/cli': minor
---

**namzu now remembers across sessions (memory layer, M4 core).**

On every turn the TUI loads `~/.namzu/USER.md` (facts about you) and `~/.namzu/MEMORY.md` (durable facts/decisions) and injects them into the agent's system prompt, so namzu carries context across runs — ask it something it learned last session and it knows. Memory is read fresh each turn, so edits take effect immediately, and it's injected only into the system prompt (never echoed into the visible transcript).

Two new slash commands:
- `/remember <text>` — append a fact to `MEMORY.md`.
- `/memory` — show what's currently stored.

When both files are empty/absent, nothing is injected and behavior is unchanged. Session-search/`/recall` and agent self-curation (memory write tools) are follow-ups.
