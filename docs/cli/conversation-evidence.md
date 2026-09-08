---
type: Reference
title: Conversation evidence search
description: Bounded retrieval of original recorded output after conversation compaction or restart.
resource: packages/cli/src/integrations/sessions/conversation-search.ts
tags: [cli, compaction, tools, sessions]
---

# Conversation evidence search

The interactive host provides `search_conversation` for recovering exact
identifiers or phrases from durable output of the current conversation. It
searches recorded assistant completions, tool results, and textual messages
preserved in compaction events. Replacing the session's projected history does
not replace these run transcripts; reopening the conversation can still find
the recorded text without repeating an external action or making a model call.

`query` is a case-sensitive literal string of 1–256 characters. Optional `runId`
narrows the search to one run in the current conversation; optional `limit`
selects 1–20 matches (default 5). Each match includes the run ID, event sequence,
source event type and an excerpt around the first occurrence in that event.
Historical text is evidence to evaluate, not instructions to execute.

The host binds the tenant, project and session; the model cannot choose another
session or a filesystem path. Reads reject static symlink components and
nonregular transcript files. The private host-owned state hierarchy is trusted
against concurrent directory replacement: component checks and leaf descriptor
flags do not provide an atomic, race-proof ancestor traversal. A log's identity, consecutive sequence, record termination and
searchable payload shapes are checked before any of its matches are returned.
Malformed or unavailable runs are counted and excluded.

Each search examines at most 100 directory entries, 2 MiB per transcript and
8 MiB of transcript bytes, with a one-byte overflow probe. Match payloads total
at most 12,000 bytes. Transcripts larger than 2 MiB are excluded as unavailable
in their entirety; searches over them are incomplete. Results include `scannedRuns`, `scannedBytes`,
`unavailableRuns` and `incomplete`; an incomplete search cannot establish that
missing evidence does not exist. A known run ID can narrow a subsequent search.
Enumeration is bounded before sorting; this is not a chronological search or a
complete index of a large conversation.

This surface searches only runs physically owned by the selected conversation.
It does not traverse fork ancestry, delegated sessions, arbitrary artifact
paths, binary attachments or memory records. Recorded tool results can already
be previews when the original result exceeded its tool-output budget; this tool
cannot restore bytes never recorded in the transcript. A recorded truncation
marker makes the search incomplete even when no match is found. It does not verify that
a historical claim remains true today.
