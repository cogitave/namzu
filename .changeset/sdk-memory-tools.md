---
'@namzu/cli': minor
---

**The agent gets the SDK's structured memory (search / read / save).**

namzu now registers the SDK's memory tools — `save_memory`, `search_memory`, `read_memory` — backed by a `DiskMemoryStore` at `~/.namzu/memory`. The agent can record and recall structured notes on demand across the session, separate from the always-injected user-curated `MEMORY.md`/`USER.md`. (This replaces the earlier ad-hoc `remember` tool; the `/remember` slash command and memory injection are unchanged.)
