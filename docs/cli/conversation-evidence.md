---
type: Reference
title: Conversation evidence search
description: Bounded retrieval of original recorded output after conversation compaction or restart.
resource: packages/cli/src/integrations/sessions/conversation-search.ts
tags: [cli, compaction, tools, sessions]
---

# Conversation evidence search

The interactive host, `run --resume` / `run --continue`, persistent
`run-stream --session`, and durable `drain` provide `search_conversation` for recovering exact
identifiers or phrases from durable output of the current conversation. It
searches recorded assistant completions, tool results, and textual messages
preserved in compaction events. Replacing the session's projected history does
not replace these run transcripts; reopening the conversation can still find
the recorded text without repeating an external action or making a model call.

Cancellation covers live boundary capture as well as the following text scan.
A tool deadline revokes that tool's capture while other calls can continue;
cancelled work is not reported as a successful empty search. A custom store
must observe the supplied signal to stop its I/O. If it ignores cancellation,
its pending operation retains writer serialization until settlement, even
though the caller stops waiting. See [SDK capture lifetime](../sdk/retained-tool-evidence.md#reading-a-running-invocation).

This includes full recorded `bash` output behind a condensed display of similar
lines. Condensation keeps an authenticated original, so earlier row values can
be retrieved without running the command again. Reading that evidence does not
establish the outcome of an action interrupted before its result was recorded.

This includes originals removed by [`/compact`](context-and-compaction.md),
archived before replacement in a separate zero-model maintenance record. User
text is not inferred from an assistant's summary. Manual archives use the same
scoped search/read paths, with `compaction_shed:user` identifying user messages.

When these tools are mounted, ordinary, resumed and resident CLI turns receive
stable guidance to recover an earlier observation if its detail is missing or
clipped. Recovery is useful before compaction too. The SDK's general evidence
rules distinguish historical observations from current state; the CLI names
the available retrieval tools and their conversation scope. Stateless hosts
receive no instruction to use unavailable conversation tools.

`drain` binds these tools to the persisted Session, Project and tenant passed
to the command. It does not create a new workspace Project or choose history
from the current folder. Retrieval uses the CLI application's conversation
hierarchy and the active writer's capture capability; `--store` names a
checkpoint queue, not an arbitrary directory the model may search. Completed
observations in a resumed batch remain retrievable even when another call in
that batch was interrupted.

A path in a retained-output preview identifies its backing file. In a CLI
conversation, use `search_conversation` and `read_conversation` for that output;
they verify ownership and retained-byte integrity. The host explicitly directs
the model to this route rather than using filesystem tools to work around a
workspace-path refusal. This guidance is not an access-control substitute:
existing tool permissions and the configured sandbox still govern execution.

For a question about what a file contained earlier, the retained observation
is the source. For a question about what it contains now, fresh workspace
evidence may be needed. These are model instructions, not a deterministic
intent classifier or a guarantee of correct source choice. Retention cannot
prove that a model saw or understood text omitted from its visible preview.

Search matches and `read_conversation` pages include optional `recordedAt`, the
stored event's recorder wall-clock Unix milliseconds. Automatic recall carries
that same value into selected passages and included duplicate occurrences. It
survives exact retained-output reads and process restart, and is available for
both indexed and older unindexed transcripts when the event has a valid stamp.
Missing or invalid stamps stay unknown; file mtime, run-start time and UUID order
are not substitutes. For `compaction_shed` it dates the copy, not the original
observation. Within a run, sequence remains authoritative even if a clock regresses.
Across runs, clocks may differ, so these stamps alone do not prove causal order
or when a fact became true. Retrieval continues to rank by lexical relevance.

Start a new search with `query`, a literal string of 1–256 characters. Continue
with `cursor` alone to restore the original query, case setting and excluded
invocation from host-owned state. This also accepts cursors supplied by automatic
evidence recall, whose multi-term query does not need to be reconstructed by the
model. An empty request with neither query nor cursor is invalid.

Automatic recall uses complete Unicode letter/number/underscore tokens with the
same lowercase matching keys as SDK relevance scoring. Its continuation restores
that matching mode too, including in older unindexed transcripts. Thus `in`
inside `Packing` does not consume an automatic candidate slot, and token `3`
does not select `13000`. A new explicit `search_conversation({query: ...})`
retains literal substring matching; the model-facing tool adds no mode argument.
When a broad automatic page covers only some query tokens and has more results,
the host may use an existing page to search the uncovered tokens. It retains the
broad continuation and makes at most one focused scan each for the current
writer and earlier invocations. The total remains four pages, at most two live,
and 8 MiB of accounted reads. Restarted reads count against that same ceiling.
If the focused scan finishes, remaining pages resume the broad cursor. Pending
broad pages still make the combined result incomplete; finishing a narrower
query never establishes complete coverage. Each cursor restores its own terms.
This improves candidate discovery behind frequent words without claiming global
ranking or semantic coverage. Queries with all or none of their tokens covered
in returned excerpts are not refined.

The temporary recall context also distinguishes complete traversal from complete
presentation. `omittedPassages` counts eligible distinct candidates withheld by
the passage or character limit. Their `additionalEvidence` addresses can be
passed to `read_conversation` to recover the exact archived text, even when the
scan has no continuation. `omittedAddresses` reports addresses which did not fit.
These are bounded-pool counts, not archive totals or proof of historical absence.
Scope, integrity and read limits are checked again when the model reads them.

For text already present in the conversation, `visibleEvidence` binds an exact
bounded `textQuote` to its validated `address`, recording time (when known),
source/tool and error/retention metadata. The quote makes the source association
explicit without loading the full archive record. Pass its `address` to
`read_conversation` for more text; reference order does not map to visible-message order. The same validation
and read limits apply. `omittedVisibleEvidence` counts references which did not
fit the shared context allowance. This can be positive even when traversal is
complete; no archive-wide absence or timestamp completeness is implied.

Matching ignores letter case
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
When a continuation exists, it explicitly directs another search with that
cursor if the excerpts do not answer the question, including empty pages and
pages matching only an announcement. Omitted/unavailable evidence without a
continuation has separate guidance; neither case proves historical absence.
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

Each call discovers at most 100 directory entries and reads at most 8 MiB, in
64 KiB chunks. Individual JSONL records are capped at 4 MiB; total transcript
size is no longer capped at 2 MiB. Match payloads total at most 12,000 bytes.
`nextCursor`, when present, continues at an unconsumed record or message inside
a compaction record. Pass it as `cursor`; optionally repeated `query` and
`caseSensitive` settings must match the original search. Omit `runId` or repeat
the original single-run ID. A recall cursor may represent a multi-term host
query, so use cursor alone for those continuations. Closed, explicitly scoped runs use the SDK
text index: one bounded index page per visited run, at most three indexed matches
per call, may require continuation even when `limit` is larger. When an indexed
run is completely searched with no matches, the call advances to the next run
within the same shared read and directory-discovery limits. It does not spend a
model round trip on each small irrelevant run. A matching or partial index page
returns control; partial empty pages still require continuation. Known omissions
stay incomplete even when scanning advances, and failed operations with unknown
read cost still charge the remaining ceiling and yield. The index also pages within large
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
Counts describe the current call. A continuation also preserves omissions seen
earlier in that same scan, including when an automatic live scan hands off to
this tool. Finishing its remaining pages does not erase a prior preview or
unavailable original. A final page may therefore have `unavailableRuns: 0`, no
`nextCursor`, and `incomplete: true`: it found no new unavailable run, but the
whole continued scan still cannot establish absence. Omissions from a separate
closed-history scan do not mark an otherwise healthy live scan as incomplete.

If an SDK operation fails before returning
its byte count, `scannedBytes` conservatively charges the remaining 8 MiB
ceiling and yields instead of attempting another run in that call. `incomplete` remains true while another page
exists or if any run or partial evidence was omitted. An authenticated full spill
does not become incomplete merely because its model-visible preview was truncated. Follow continuation even
when the current page has zero matches. Incomplete absence is not proof that
missing evidence does not exist. Directory discovery also continues: after the
current batch's runs have been visited, the next call discovers up to 100 more
entries. Empty batches containing no run IDs still return a continuation. Run
IDs are sorted within each batch; discovery order is the filesystem's order,
not chronology or relevance ranking. An exact `runId` bypasses enumeration.

Directory continuations retain a private descriptor and cached name pages,
bounded to 32 scans and 128 pages per process. Concurrent use of the same
continuation returns the same page. Names are discovery hints, never ownership
authority or cached evidence: each run still passes the regular scope and
source checks. A changed or replaced run directory invalidates further
discovery and requires a new search. Exhaustion closes the descriptor;
expiration, eviction and CLI Session shutdown release abandoned scans. Cursors
are process-local and do not survive restart. An exactly full directory batch
may require one final empty page to establish exhaustion.

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
match the authorized conversation. For other explicitly scoped runs with `idle`,
`pending` or `running` metadata, the CLI uses the SDK's snapshot consistency mode.
This includes interrupted runs whose process exited before terminal status was
recorded. It recovers authenticated original output without assuming whether a
writer is alive, acquiring its execution lease, resuming actions or changing the
stored status. The transcript and metadata are checked before and after every
operation. Changes invalidate the snapshot cursor/address and require a fresh
search. Unlike the requesting writer's captured boundary, these snapshots do
not preserve cursors across concurrent appends.

An incomplete final JSONL fragment is excluded using a bounded backward scan,
charged to the existing 8 MiB allowance. The original transcript is not repaired
or truncated. Nonterminal snapshot search remains `incomplete: true`, even with
no continuation; a full exact read establishes the selected recorded text, not
that the interrupted task finished. A complete but malformed record still
fails validation. An unbounded or absent complete prefix is unavailable.

Unsupported stores and older unscoped records retain the bounded transcript
scan. Contradictory ownership or an unknown scoped status is refused. An indexed
or snapshot cursor cannot downgrade to that scanner when its source becomes
ineligible; an existing live cursor still requires its original writer.

Without a retained authenticated original, a recorded tool preview stays a
preview. Its truncation marker makes search incomplete even for a negative
query. Neither source establishes that a historical claim is still true today.

New oversized host output in recorded CLI turns uses a 4,000-character preview
after its full text and integrity manifest are saved. The original spill
threshold remains 40,000 characters; smaller results are unchanged. This limits
repeated preview cost without removing the exact source searched here. Set
[`compaction.retainedToolPreviewChars: 0`](context-and-compaction.md) to keep
the earlier preview size. Existing transcripts are not rewritten, and failed
retention falls back to the ordinary output budget.

## Exact retained text

`read_conversation({ runId, seq, part?, byteOffset? })` returns exact retained text rather
than a summary or search excerpt. `part` defaults to zero; compaction events
can contain several textual messages with different part indices. The tool
shares search's host-bound ownership and filesystem checks. It never reads
caller-selected paths or follows an `outputSpillPath` from a transcript.
After an indexed, snapshot or live search returns a match, the CLI temporarily retains its
authenticated SDK address under this conversation's root, tenant, project,
session, run, sequence and part. A following read can go directly to that source
instead of locating the same record again from the first index page. It still
reopens the source, checks current ownership and authenticates the record and
requested text; a changed closed source is refused, not silently substituted.
Only locations are retained, not text or authorization. The process holds at most
128 locations for ten minutes, and releases them when the conversation host closes.
After expiry, eviction or process restart, the durable run/sequence/part address
still works through bounded lookup pages. A read advances through up to eight
SDK lookup pages within the same shared 8 MiB allowance, instead of yielding
solely because an intermediate index page is empty. Each operation reopens the
source and checks ownership with the remaining byte budget. Lookup yields when
fewer than 6 MiB remain for the next SDK operation, eight pages have been visited
without locating the part, or an unfinished continuation has made no progress.
Its saved position resumes on the next
call, including when the text has been located but reading it needs a fresh
budget. The ceiling bounds both I/O and work on very small pages; it does not
guarantee that every address returns text in one call.
If a former live owner is gone, a fresh read can locate its closed run or
nonterminal snapshot normally; an already-issued live read cursor
retains its existing owner requirement.

Supply the optional `byteOffset` from search to start near a match, or omit it
to read from the beginning. Copy the returned value exactly: rounding or estimating
a byte position can split a UTF-8 character and is refused. The read tool's error
guidance points back to the exact search position without exposing private paths.
Repeat that initial offset unchanged with subsequent
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
cursor. Closing the host releases both kinds of cursor. After restart or expiry, begin again from the durable address without
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
guidance is preserved. The inventory uses SDK
[`prepareStep.context`](../sdk/step-context.md), keeping it after history through
OpenAI and Anthropic conversion. Preceding context stages are composed; system
stages remain untouched. It is labelled runtime context, recomputed on each
request, and not retained as operator input. Stable placement does not guarantee
provider cache hits or reduce total input tokens by itself.

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

The later [natural-language experiment](../../research/conversation-evidence/natural-results.md)
did not tell the model which retrieval tools to use. Both eligible live samples
substituted current file values for historical ones; a third sample had an
incomplete initial inspection. Its scripted control recovered the originals.
These failures remain recorded: reliable source selection in natural dialogue
is still open, despite working storage and exact-read contracts.
