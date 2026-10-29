---
"@namzu/cli": patch
---

Release this process's session writer leases before a normal or reported-error binary exit. Closing the TUI while query cleanup is unfinished no longer leaves an otherwise idle conversation refusing immediate resume until its five-minute lease expires. Signal shutdown and embedded command calls retain their existing ownership behavior.

Show an occupied stored-memory lock's path and recovery instructions without requiring debug mode. Memory locks remain separate from session leases and are not removed automatically.
