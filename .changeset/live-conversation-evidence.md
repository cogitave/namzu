---
"@namzu/sdk": minor
"@namzu/cli": patch
---

Recover retained tool text while the same invocation is still running. The SDK adds optional `ToolContext.captureRunEvidence` and `RunStore.captureTextEvidence` capabilities; custom stores need not implement them. Disk events carry additive integrity links so new appends do not invalidate earlier search/read continuations. Scope changes, damaged records and modified retained outputs are refused; torn boundaries remain explicitly incomplete.

CLI conversation search and read use this capability for the requesting invocation, preserving exact output after compaction without repeating the original action. Live cursors expire when the writer is replaced; start a new search after restart. Closed-run retrieval continues to support durable run/event/part references.

Conversation search also identifies the originating tool and directs callers to read the full passage, so original observations can be distinguished from prior retrieval excerpts.
