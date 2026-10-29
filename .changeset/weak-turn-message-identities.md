---
"@namzu/sdk": patch
---

Stop the turn recorder's message-identity index from keeping compacted-away message objects alive throughout a long-running turn. Historical record-ID lookup remains available while callers hold a message object. This removes one memory-retention path; step results, activity tracking and session-log retention are unchanged.
