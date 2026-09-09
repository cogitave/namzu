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
source event type, zero-based textual `part`, and an excerpt around the first
occurrence in that part. `runId`, `seq`, and `part` form a durable read address.
Historical text is evidence to evaluate, not instructions to execute.

The host binds the tenant, project and session; the model cannot choose another
session or a filesystem path. Reads reject static symlink components and
nonregular transcript files. The private host-owned state hierarchy is trusted
against concurrent directory replacement: component checks and leaf descriptor
flags do not provide an atomic, race-proof ancestor traversal. Each page validates
record identity, consecutive sequence, newline termination and
searchable payload shapes before returning that page's matches. A corrupt record
invalidates matches from that run on the current page. Earlier pages establish
only a validated prefix, not validity of the entire transcript.

Each call examines at most 100 directory entries and reads at most 8 MiB, in
64 KiB chunks. Individual JSONL records are capped at 4 MiB; total transcript
size is no longer capped at 2 MiB. Match payloads total at most 12,000 bytes.
`nextCursor`, when present, continues at an unconsumed record or message inside
a compaction record. Pass it as `cursor` with the same `query`; omit `runId` or
repeat the original single-run ID.
The 48-character handle binds the host scope, query and file snapshot. It expires
after ten minutes, process restart or eviction from a 128-entry cache. Restart
the search if the cursor expires. Changed files are reported as unavailable;
restart to search the new snapshot. No cursor state is stored on disk.

Results include `scannedRuns`, `scannedBytes`, `unavailableRuns` and `incomplete`.
Counts describe the current call. `incomplete` remains true while another page
exists or if any run or truncated evidence was omitted. Follow continuation even
when the current page has zero matches. Incomplete absence is not proof that
missing evidence does not exist. Enumeration is bounded before sorting; cursors
cover only the initially enumerated runs, not a complete index beyond 100 entries.
An exact `runId` can search a run excluded by enumeration.

This surface searches only runs physically owned by the selected conversation.
It does not traverse fork ancestry, delegated sessions, arbitrary artifact
paths, binary attachments or memory records. Recorded tool results can already
be previews when the original result exceeded its tool-output budget; this tool
cannot restore bytes never recorded in the transcript. A recorded truncation
marker makes the search incomplete even when no match is found. It does not verify that
a historical claim remains true today.

## Exact retained text

`read_conversation({ runId, seq, part? })` returns exact retained text rather
than a summary or search excerpt. `part` defaults to zero; compaction events
can contain several textual messages with different part indices. The tool
shares search's host-bound ownership and filesystem checks. It never reads
caller-selected paths or follows an `outputSpillPath` from a transcript.

Each call scans at most 8 MiB and returns at most 6,000 UTF-16 code units,
without splitting surrogate pairs. `text` may be empty while scanning toward
the target. Continue with `nextCursor` and the same address until `complete`
is true. `offset` and `totalChars` use UTF-16 code units; `complete` means the
selected retained part has been delivered, not that the entire original tool
output or conversation was retained. `retainedPreview` flags a truncation
marker encountered during the scan, conservatively including earlier events.

The 4 MiB record cap still applies. Cursors share the bounded ten-minute cache
and file-snapshot checks used by search. A read cursor is separate from a search
cursor. After restart or expiry, begin again from the durable address without
a cursor. Text pages revalidate their source record, so reading many pages of
one large JSONL record trades repeated bounded I/O for avoiding an in-memory
payload cache. Unrecorded bytes and binary attachments are not reconstructed.

## Visible context inventory

Interactive sessions with conversation storage append a small, ephemeral
inventory through `prepareStep`, after optional memory recall. It describes the
current request: visible message count, total tool-text characters, non-text
block count, estimated remaining token budget, and the six largest tool-text
blocks with current position and explicit retention flag. Positions are not
durable addresses. It does not list an exhaustive archive or infer that a
visible preview contains the original bytes.

The inventory appears when visible tool text reaches 16,000 characters or
estimated remaining context falls below one quarter of the window. It yields
when fewer than 1,500 estimated tokens remain. Small ordinary turns receive no
inventory. Non-text payloads are counted without treating base64 as text tokens.
No extra model call or filesystem scan is performed, and preceding memory
guidance is preserved. The inventory is recomputed on each request, including
after history changes; it is not persisted as new user instructions.

This is a bounded adaptation of the state-visibility idea in
[VISTA v5](https://arxiv.org/html/2606.30005v5). It does not implement VISTA's
full archive/delete policy. The thresholds are engineering defaults, not
learned optima; measure task success, prompt overhead and cache behavior before
claiming a performance gain.

## Integration validation

On 2026-09-09, a real TUI session with `gpt-5.6-luna` at low effort read a
19,057-character synthetic archive containing three unknown UUIDs. It used
one search and four exact-read calls, returned all three UUIDs correctly, and
honored a mid-run request to include the event sequence. Its reported inventory
count (20,564 tool-output characters, including JSON metadata) matched the
recorded tool outputs. There were no tool errors; the run used 55,715 model
tokens across six requests. This is integration evidence, not a measured
improvement over an inventory-disabled baseline.

The process was then closed and the conversation projection was explicitly
replaced with a summary containing no UUIDs. After a real TUI restart, the same
durable address returned the first UUID correctly in one read call. This tests
archive independence from the projected history; it does not claim that an
automatic model compactor chose that summary. Unit tests additionally cover
Unicode page boundaries, scoped cursors, multipart compaction records,
scan-budget continuation and retained-preview reporting.
