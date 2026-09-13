---
"@namzu/sdk": minor
"@namzu/cli": patch
---

When automatic evidence query resolution is enabled, allow its existing bounded
planner to select grounded subject words for discovery. A named record can now
focus the search without generic field words filling context with other records.
Source spelling, quoted context and every candidate's conversation ownership
are validated before use.

Temporary context reports the selected focus, observed focus words and locally
excluded passages. An empty focused scan is explicitly not proof of archive
absence. Explicit conversation search/read tools remain available with their
existing semantics; no additional model call or retrieval budget is introduced.
SDK query resolution remains opt-in. CLI integration checks cover archived
observations after reopening a conversation.
