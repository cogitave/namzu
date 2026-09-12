---
"@namzu/sdk": minor
"@namzu/cli": minor
---

Residents can retrieve earlier settled summaries and consumed wake inputs when
the latest summary omits needed evidence. The SDK adds experimental
`DiskResidentAgenda.history`, `ResidentHistorySource` and related result types,
`buildResidentHistoryTools`, and optional `ResidentStepPromptOptions.history`.
Searches are bounded and paged, tied to one pursuit and an explicit upper
revision, and report unreadable evidence without treating it as proven absence.

CLI foreground and managed resident runs mount the two read-only recall tools
in both context profiles, including deferred loading. Ordinary conversations
and delegated children do not inherit the resident's history. These tools read
existing immutable revisions; they do not restore full tool transcripts, replay
actions, or change the persisted schema.
