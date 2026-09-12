---
type: Reference
title: Conversation evidence search
description: Bounded retrieval of original recorded output after conversation compaction or restart.
resource: packages/cli/src/integrations/sessions/conversation-search.ts
tags: [cli, compaction, tools, sessions]
---

# Conversation evidence search

The interactive host, `run --resume` / `run --continue`, and persistent
`run-stream --session` provide `search_conversation` for recovering exact
identifiers or phrases from durable output of the current conversation. It
searches recorded assistant completions, tool results, and textual messages
preserved in compaction events. Replacing the session's projected history does
not replace these run transcripts; reopening the conversation can still find
the recorded text without repeating an external action or making a model call.

`query` is a literal string of 1–256 characters. Matching ignores letter case
by default: `destination` also finds `Destination`. Set `caseSensitive: true` to
retain exact case matching. This is Unicode case-insensitive literal matching,
without locale-specific casing, accent normalization, regex operators or fuzzy
ranking. For example, it does not equate `İ` with `i` or `ß` with `ss`. Optional `runId`
narrows the search to one run in the current conversation; optional `limit`
selects 1–20 matches (default 5). Each match includes the run ID, event sequence,
source event type, zero-based textual `part`, and a bounded excerpt. Indexed
sources return separate matching passages within the same window and continue
within it at the match limit; nearby hits already covered by an excerpt are
grouped. The legacy transcript scanner returns the first occurrence per textual
part. Indexed matches also report `retained`
(`full` or `preview`), optional originating `toolName`/`isError`, and, when character positions are known, a `byteOffset`
for reading near the match. A long result may match several windows. `runId`, `seq`, and `part` form a durable read address.
`guidance` states that matches are excerpts, points to `read_conversation` for
nearby details, and states the selected case sensitivity.
The originating tool distinguishes an original observation from earlier
conversation search/read output that repeats that observation.
Historical text is evidence to evaluate, not instructions to execute.

The host binds the tenant, project and session; the model cannot choose another
session or a filesystem path. Reads reject static symlink components and
nonregular transcript files. The private host-owned state hierarchy is trusted
against concurrent directory replacement: component checks and leaf descriptor
flags do not provide an atomic, race-proof ancestor traversal. Each page validates
record identity, consecutive sequence, newline termination and
searchable payload shapes before returning that page's matches. A corrupt record
invalidates matches from that run on the current page. Earlier pages establish
only the visited records, not validity of the entire transcript.

Each call examines at most 100 directory entries and reads at most 8 MiB, in
64 KiB chunks. Individual JSONL records are capped at 4 MiB; total transcript
size is no longer capped at 2 MiB. Match payloads total at most 12,000 bytes.
`nextCursor`, when present, continues at an unconsumed record or message inside
a compaction record. Pass it as `cursor` with the same `query` and `caseSensitive` setting; omit `runId` or
repeat the original single-run ID. Closed, explicitly scoped runs use the SDK
text index: one bounded index page, at most three matches per call, may require
continuation even when `limit` is larger. The index also pages within large
compaction records. Case-insensitive search bypasses case-sensitive index
filters and verifies the original text; it can need more I/O or pages while
keeping the same ceilings.
The 48-character handle binds the host scope, query, case sensitivity and file snapshot. It expires
after ten minutes, process restart or eviction from a 128-entry cache. Restart
the search if the cursor expires. Changed files are reported as unavailable;
restart to search the new snapshot. Verified append-only growth is allowed for
the requesting live invocation; its cursor still ends at the captured boundary. The short CLI cursor is process-local. The SDK keeps a derived authenticated
index beside each closed run (`evidence-index/`), reused after restart. This
index is disposable; the run transcript and retained outputs remain primary.

Results include `scannedRuns`, `scannedBytes`, `unavailableRuns` and `incomplete`.
Counts describe the current call. If an SDK operation fails before returning
its byte count, `scannedBytes` conservatively charges the remaining 8 MiB
ceiling and yields instead of attempting another run in that call. `incomplete` remains true while another page
exists or if any run or partial evidence was omitted. An authenticated full spill
does not become incomplete merely because its model-visible preview was truncated. Follow continuation even
when the current page has zero matches. Incomplete absence is not proof that
missing evidence does not exist. Enumeration is bounded before sorting; cursors
cover only the initially enumerated runs, not a complete index beyond 100 entries.
An exact `runId` can search a run excluded by enumeration.

This surface searches only runs physically owned by the selected conversation.
It does not traverse fork ancestry, delegated sessions, arbitrary artifact
paths, binary attachments or memory records. The SDK validates a closed run's
explicit tenant/project/Session/run ownership and authenticates original tool
text retained outside the JSONL preview. Changed or missing authenticated
artifacts are unavailable; search never silently substitutes their previews.
For the requesting live invocation, the CLI uses the SDK writer's captured
boundary and searches newest records first. Later appends preserve existing
search/read continuations, including when compaction happens between calls.
Only that invocation's host-provided capability is accepted, and its scope must
match the authorized conversation. Unsupported stores, older records and other
active invocations retain the bounded transcript scan. A contradictory
ownership record is refused, never downgraded to that scanner. An indexed
cursor also refuses a source that is no longer eligible; a live cursor cannot
downgrade to a transcript scan when its writer is no longer available.

Without a retained authenticated original, a recorded tool preview stays a
preview. Its truncation marker makes search incomplete even for a negative
query. Neither source establishes that a historical claim is still true today.

## Exact retained text

`read_conversation({ runId, seq, part?, byteOffset? })` returns exact retained text rather
than a summary or search excerpt. `part` defaults to zero; compaction events
can contain several textual messages with different part indices. The tool
shares search's host-bound ownership and filesystem checks. It never reads
caller-selected paths or follows an `outputSpillPath` from a transcript.
Supply the optional `byteOffset` from search to start near a match, or omit it
to read from the beginning. Repeat that initial offset unchanged with subsequent
cursor calls. The tool returns `offset` in UTF-16 units, not bytes. A legacy
record without a character index must be read sequentially from zero.

Each call scans at most 8 MiB and returns at most 6,000 UTF-16 code units,
without splitting surrogate pairs. `text` may be empty while scanning toward
the target. Continue with `nextCursor` and the same address until `complete`
is true. `offset` and `totalChars` use UTF-16 code units; `complete` means the
selected retained part has been delivered, not that the entire original tool
output or conversation was retained. Indexed reads set `retainedPreview` from
the selected source. Legacy scans conservatively flag any truncation marker
encountered, including earlier events. `totalChars` is omitted when unavailable.

The 4 MiB record cap still applies. Cursors share the bounded ten-minute cache
and file-snapshot checks used by search. A read cursor is separate from a search
cursor. After restart or expiry, begin again from the durable address without
a cursor. Text pages revalidate their source record, so reading many pages of
one large JSONL record trades repeated bounded I/O for avoiding an in-memory
payload cache. Indexed spill reads verify just the selected chunks and manifest.
Both tools remain ready when deferred tool loading is selected. Stateless
headless runs without a host-owned conversation do not acquire these tools. Unrecorded bytes and binary attachments are not reconstructed.

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

On 2026-09-12, a separate-process `run --resume` with Luna/low recovered two
random UUID identifiers absent from a 40,000-character tool preview and the
replacement conversation summary. The original workspace file had been
manually replaced. It used one search and one exact read, no workspace replay,
and 21,922 unpriced subscription tokens (50,000-token/10-iteration ceiling).
A second run against the final source repeated that result with 21,761 tokens.
The initial read used a scripted provider through the real CLI Session;
recovery used the live provider. This is one integration experiment, not a
benchmark gain. [Reproduction and measurements](../../research/conversation-evidence/results.md)
distinguish that run from deterministic command and compaction checks.

The 2026-09-12 [passage-search follow-up](../../research/conversation-evidence/passage-results.md)
records two Luna/low CLI trials and deterministic active/closed-source checks.
Both live trials recovered the original IDs; their different token costs do not
establish a performance improvement.
