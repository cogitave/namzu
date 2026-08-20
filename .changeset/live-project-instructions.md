---
"@namzu/sdk": minor
"@namzu/cli": major
---

Add a host-owned live project-instruction context to the SDK. Queries and all
agent front doors can rebuild a retained snapshot before the first provider
request, observe completed top-level and nested registry executions, and
durably replace that snapshot after a complete tool batch without creating a
human continuation. Project-instruction messages carry bounded canonical
project-relative `AGENTS.md` provenance and survive compaction.

BREAKING: the CLI now represents repository instructions as scoped, retained
conversation context instead of a frozen system-prompt block. Hosts that inspect
raw provider messages or persisted session history must handle the
`project-instructions` user-message source. This lets nested instructions take
effect during the session and lets reconstruction re-read current disk content
instead of replaying stale policy prose.
