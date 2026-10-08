---
"@namzu/sdk": patch
---

A saved engine tool named `wait`, `wait_agent` or `waitagent` now reads "Waited for agent", and `close_agent`, `interrupt_agent` or `kill_agent` (any casing, with or without the underscore) read "Stopped agent", where they read "Used wait agent" and so on before. No export or type changes; a consumer that matched on the old label text should match the new one.
