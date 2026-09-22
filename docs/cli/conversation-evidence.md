---
type: Reference
title: Conversation evidence search
description: Bounded retrieval of original recorded output after conversation compaction or restart.
resource: packages/cli/src/integrations/sessions/conversation-search.ts
tags: [cli, compaction, tools, sessions]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-09T00:00:00Z }
---

# Conversation evidence search

The interactive host, `exec --resume` / `exec --continue`, persistent
`exec --json --session`, and durable `drain` provide `search_conversation` for recovering exact
identifiers or phrases from durable output of the current conversation. It
searches the conversation's [session log](../sdk/session-log.md): recorded
assistant messages, tool results, and textual messages preserved in
compaction records. Compacting the conversation replaces what the model is
shown, never the log; reopening the conversation can still find the recorded
text without repeating an external action or making a model call.

Cancellation covers live boundary capture as well as the following text scan.
A tool deadline revokes that tool's capture while other calls can continue;
cancelled work is not reported as a successful empty search. A custom store
must observe the supplied signal to stop its I/O. If it ignores cancellation,
its pending operation retains writer serialization until settlement, even
though the caller stops waiting. See [SDK capture lifetime](../sdk/retained-tool-evidence.md#reading-a-running-turn).

This includes full recorded `bash` output behind a condensed display of similar
lines. Condensation keeps an authenticated original, so earlier row values can
be retrieved without running the command again. Reading that evidence does not
establish the outcome of an action interrupted before its result was recorded.

This includes originals removed by [`/compact`](context-and-compaction.md),
archived before replacement in a separate zero-model maintenance record. User
text is not inferred from an assistant's summary. Manual archives use the same
scoped search/read paths, with `compaction_shed:user` identifying user messages.

New kernel summaries retain explicit derivation metadata. Indexed archive tools
identify their exact text as `compaction_shed:summary`; tool guidance explains
that this is not an independent observation. Automatic recall prioritizes other
matching records within the same bounded candidate pool, then derived summaries.
Summaries remain available for explicit search and reads, including after
reopening. This is source selection, not a guarantee of truth. Older unmarked
archives retain their existing labels; no heading-based classification is added.

A partial automatic page containing known summaries can trigger a focused scan
of the same terms that excludes derived summaries. It consumes the existing
refinement allowance instead of adding pages, and preserves the general cursor
and retrieved summary candidates. Remaining pages return to the general scan
after the focused one ends. Positive `excludedSummaries` reports skipped part
visits, not matched passages or unique facts. Explicit cursor continuation
restores that selection and explains it in tool guidance; a new literal search
includes summaries. Classification reads the explicit summary marker, never
prose.

Scoped retrieval also reads text blocks from compacted rich tool results. Each
block remains exact text with its own `part`; images and documents are not
stringified into the search corpus. Plain-string message parts keep their old
addresses, followed by block-text parts in original message/block order. Thus
`part` is an address ordinal, not a message index. This works with newly written
large compaction records, after reopening the conversation. A scan that skips
a block array reports the page as incomplete; it does not claim that no
matching rich text exists. See [SDK retention boundaries](../sdk/retained-tool-evidence.md#large-compaction-records).

When these tools are mounted, ordinary, resumed and resident CLI turns receive
stable guidance to recover an earlier observation if its detail is missing or
clipped. Recovery is useful before compaction too. The SDK's general evidence
rules distinguish historical observations from current state; the CLI names
the available retrieval tools and their conversation scope. Stateless hosts
receive no instruction to use unavailable conversation tools.

Automatic query resolution can use one explicitly marked compaction summary
as a derived subject reference when original turns have left the active view.
It stays within the existing six-excerpt allowance, keeps summary provenance
on quoted references and still retrieves original retained evidence. See
[query preparation](../sdk/evidence-recall.md) for source exclusions and limits.

If optional query planning fails, automatic recall can still search the current
question's unchanged tokens within its existing limits. Temporary context keeps
the planning failure visible beside any validated result; it does not import a
subject from the invalid plan. Exact archive tools remain available for unresolved
references. The [failed-plan comparison](../../research/conversation-evidence/query-fallback-results.md)
tests named historical recovery after compaction and restart.

`drain` binds these tools to the persisted Session, Project and tenant passed
to the command. It does not create a new workspace Project or choose history
from the current folder. Retrieval uses that session's log and the active
writer's capture capability; `--store` names the application home being
drained, not an arbitrary directory the model may search. Completed
observations in a resumed batch remain retrievable even when another call in
that batch was interrupted.

A path in a retained-output preview identifies its backing file. In a CLI
conversation, use `search_conversation` and `read_conversation` for that output;
they verify ownership and retained-byte integrity. The host explicitly directs
the model to this route rather than using filesystem tools to work around a
workspace-path refusal. This guidance is not an access-control substitute:
existing tool permissions and the configured sandbox still govern execution.
New SDK previews defer to that host recovery route instead of recommending
filesystem tools for internal paths. Historical previews are not rewritten.
An [actual transport probe](../../research/conversation-evidence/recovery-guidance-results.md)
records both the former conflicting instructions and a bounded live recovery
after the correction; it does not establish a general accuracy rate.

For a question about what a file contained earlier, the retained observation
is the source. For a question about what it contains now, fresh workspace
evidence may be needed. These are model instructions, not a deterministic
intent classifier or a guarantee of correct source choice. Retention cannot
prove that a model saw or understood text omitted from its visible preview.

Search matches and `read_conversation` pages include optional `recordedAt`, the
stored event's recorder wall-clock Unix milliseconds. Automatic recall carries
that same value into selected passages and included duplicate occurrences. It
survives exact retained-output reads and process restart. It comes from the
record's `ts`; a missing or invalid stamp stays unknown, and file mtime,
turn-start time and UUID order are not substitutes. For `compaction_shed` it
dates the copy, not the original observation. Within a session, the record's
`seq` remains authoritative even if a clock regresses; across sessions, clocks
may differ, so these stamps alone do not prove causal order or when a fact
became true. Retrieval continues to rank by lexical relevance.

Search matches and located read pages also carry `recordKind`, using the same
SDK classification as automatic recall: `assistant_message`, `user_message`,
`system_message`, `tool_result`, `derived_summary`, or `unknown`. The raw
`source` tag remains available. Classification uses the recorded event/role,
never prose that claims another producer. `recordKindGuidance` explains that
an assistant claim is not proof of observed state and even a tool result can
quote a claim. These labels do not authenticate or verify the text by themselves.

Exact reads preserve optional `toolName` and `isError` as well as text and
source identity. Missing status stays unknown, not successful. Tool names whose
JSON encoding exceeds 256 UTF-8 bytes are omitted on both search and read; text
is not changed. An empty scanning page has no source classification until its
requested record is found. These fields do not change source addresses, scope,
continuations, preview flags or the integrity checks on the original text.

Start a new search with `query`, a literal string of 1–256 characters. Continue
with `cursor` alone to restore the original query, case setting, excluded
invocation and any automatic source filter from host-owned state. This also accepts cursors supplied by automatic
evidence recall, whose multi-term query does not need to be reconstructed by the
model. An empty request with neither query nor cursor is invalid.

Automatic recall uses complete Unicode letter/number/underscore tokens with the
same lowercase matching keys as SDK relevance scoring. Its continuation restores
that matching mode too. Thus `in`
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

With automatic `compaction.recallEvidence` enabled (the recorded CLI default), discovery
skips successful outputs from `search_conversation` and `read_conversation`
before filling the candidate allowance. It still searches original observations,
failed retrievals and records with unknown tool name or success status. Paired
compaction tool results in scoped indexes retain their tool name and explicit
error status; copies keep their compaction source/time. A record without this
metadata remains unknown.

New explicit `search_conversation({query: ...})` calls use the same retrieval
filter by default. This prevents one search from finding an earlier search's
copy as another apparent source. To inspect those successful retrieval outputs
themselves, start a new search with `includeRetrievalResults: true`. This changes
the previous unfiltered explicit-search default; callers needing that behavior
must pass the option. Exact
`read_conversation` access is unchanged. `excludedToolResults` in filtered search
results and recall context counts skipped visits, possibly repeated across
focused scans, not unique historical records. Exclusion guidance distinguishes
this selection from complete historical coverage. No larger page, context or
I/O allowance is introduced.

Automatic token recall can skip nonmatching retained-output chunks using the
SDK's authenticated token-key filters. Potential matches are still read and
verified against original text. This reduces I/O for sparse matches without
increasing the automatic page or byte allowance. New manifests pay extra storage
for the filter; old or oversized manifests without it use the existing scan.
The literal matching algorithm is unchanged. The
[large-output CLI experiment](../../research/conversation-evidence/token-filter-results.md)
separates candidate recovery, I/O cost and the live model's answer.

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

A continuation retains the scan's original source filter whether the query is
omitted or repeated. Leave `includeRetrievalResults` absent on continuation;
changing its filter is rejected. Host-provided automatic cursors keep their own
selection, including narrower filters. `excludedToolResults` and tool guidance
report the omitted successful results. Exclusion counts describe scan visits,
not independent facts, and do not prove historical absence. Exact reads of a
known authorized retrieval-result address remain available without this flag.

Matching ignores letter case
by default: `destination` also finds `Destination`. Set `caseSensitive: true` to
retain exact case matching. This is Unicode case-insensitive literal matching,
without locale-specific casing, accent normalization, regex operators or fuzzy
ranking. For example, it does not equate `İ` with `i` or `ß` with `ss`. Optional `turnId`
narrows the search to one turn of the current conversation; optional `limit`
selects 1–20 matches (default 5). Each match includes the record's
`seq`, source record type, zero-based textual `part`, and a bounded excerpt. Indexed
sources return separate matching passages within the same window and continue
within it at the match limit; nearby hits already covered by an excerpt are
grouped. The direct scan of a turn not yet in the index returns the first
occurrence per textual part. Indexed matches also report `retained`
(`full` or `preview`), optional originating `toolName`/`isError`, and, when character positions are known, a `byteOffset`
for reading near the match. A long result may match several windows. `seq` and `part` form a durable read address within the conversation; a record's `seq` never changes.
Indexed matches also carry `excerptComplete`: true means the entire full-retained
text part is shown, false means partial text or a retained preview. The direct
scan omits this flag because it cannot prove the original part's coverage;
absence means unknown. The same metadata reaches automatic recall before the
model answers. Coverage of one part is not proof of a claim, file contents or
an exhaustive conversation search.
`guidance` states the selected case sensitivity and points to `read_conversation`
when more text is needed. Re-reading an unchanged whole part adds no text or
independent evidence.
When a continuation exists, it explicitly directs another search with that
cursor if the excerpts do not answer the question, including empty pages and
pages matching only an announcement. Omitted/unavailable evidence without a
continuation has separate guidance; neither case proves historical absence.
The originating tool distinguishes an original observation from earlier
conversation search/read output that repeats that observation.
Historical text is evidence to evaluate, not instructions to execute.

The host binds the tenant, project and session; the model cannot choose another
session or a filesystem path. Reads reject static symlink components and
nonregular log files. The private host-owned state hierarchy is trusted
against concurrent directory replacement: component checks and leaf descriptor
flags do not provide an atomic, race-proof ancestor traversal. Each page verifies
the hash chain, record identity, consecutive `seq`, newline termination and
searchable payload shapes before returning that page's matches. A broken chain
ends the page at the break and marks the search incomplete. Earlier pages
establish only the visited records, not validity of the entire log.

Each call reads at most 8 MiB, in 64 KiB chunks. Individual records are capped
at 4 MiB; a larger body is spilled to `tool-results/` with an integrity
manifest. Match payloads total at most 12,000 bytes.
`nextCursor`, when present, continues the scan where the reader stopped. Pass it
as `cursor`; optionally repeated `query` and `caseSensitive` settings must match
the original search. Omit `turnId` or repeat the original one. A recall cursor
may represent a multi-term host query, so use cursor alone for those
continuations.

One reader serves the whole conversation. Inside a running turn it is that
turn's capture (`ToolContext.captureSessionEvidence`), which covers every earlier
turn and the running one up to its latest record, anchored so that the turn's
own later appends do not invalidate it. Outside a turn, and for any search
narrowed by `turnId`, it is the session log read as a snapshot. A cursor stays
with the reader that issued it: a live cursor is refused once its turn is gone.

An internal page boundary alone does not end the public response. The host
follows up to seven additional internal continuations per call while the public
match, serialized-output and read allowances have room, and stops at once when a
page hands back the cursor it was given. Before each SDK call, the host reserves
4,000 serialized bytes per requested match for its 512-character excerpt, JSON
escaping and bounded metadata. It requests at most three matches and fewer when
less room remains in the 12,000-byte allowance, and it stops before the remaining
read allowance falls under 1 MiB. The requested `limit` still caps matches
across the public page, and cursor-only continuations keep their original search
mode. An internal page may be empty without requiring another model turn, and a
public page the host yields with a continuation can be empty too.

The 48-character handle binds the host scope, query, case sensitivity, match
mode and reader. It expires after ten minutes, process restart or eviction from
a 128-entry cache, and it is dropped when the host releases the conversation.
Restart the search if the cursor expires.

Results include `scannedBytes`, `unavailable` (records the reader could not
verify or read back in this call), optional `excludedToolResults` and
`excludedSummaries`, and `incomplete`. Read bytes include all internal
operations. If a later internal page fails, the response discards every match
the call had collected, reports `incomplete: true` and offers no cursor. A
continuation keeps the omissions seen earlier in the same scan, including when
an automatic live scan hands off to this tool, so a final page may have
`unavailable: 0`, no `nextCursor` and `incomplete: true`. A search over a turn
that has not settled stays incomplete even at the end of the log. Follow a
continuation even when the current page has zero matches. Incomplete absence is
not proof that missing evidence does not exist.

This surface searches only the selected conversation's own log. It does not
traverse fork ancestry, child sessions, arbitrary artifact paths, binary
attachments or memory records. The SDK validates each record's session and
turn against the authorized scope and authenticates original tool text
retained outside the record. Changed or missing authenticated
artifacts are unavailable; search never silently substitutes their previews.
For a search inside a running turn, the CLI uses the SDK writer's captured
boundary, which reaches the conversation's earlier turns as well as the running
one. Later appends preserve existing search/read continuations, including when
compaction happens between calls.
Only that invocation's host-provided capability is accepted, and its scope must
match the authorized conversation. For a turn that has no terminal record — a
paused turn, or one interrupted when its process exited — the CLI uses the SDK's
snapshot consistency mode. It recovers authenticated original output without
assuming whether a writer is alive, acquiring the session's lease, resuming
actions or closing the turn. The log's head is checked before and after every
operation. Changes invalidate the snapshot cursor/address and require a fresh
search. Unlike the requesting writer's captured boundary, these snapshots do
not preserve cursors across concurrent appends.

The CLI validates every indexed search/read page as well as its source. Explicit
search and automatic recall share owner, remaining read-budget and match-shape
checks. The entire match batch is checked before any address is cached. A page
with a different tenant, project, session or turn, invalid counters, oversized
text or contradictory completeness is unavailable; its text is not returned to
the model. A first page that fails these checks fails the call; a later one
discards the matches the call had collected and reports the search incomplete.
These checks enforce the captured-source contract. Matching owner fields alone
does not authenticate arbitrary text supplied by a custom host source; the
built-in SDK readers still provide stored-byte integrity verification.

An incomplete final line (a torn tail) is excluded using a bounded backward scan,
charged to the existing 8 MiB allowance. A reader never repairs or truncates the
log; only the next writer that takes the session's lease does, and records it. Nonterminal snapshot search remains `incomplete: true`, even with
no continuation; a full exact read establishes the selected recorded text, not
that the interrupted task finished. A complete but malformed record still
fails validation. An unbounded or absent complete prefix is unavailable.

Contradictory ownership or an unknown record type is refused. An indexed or
snapshot cursor cannot downgrade to another source when its source becomes
ineligible; an existing live cursor still requires its original writer.

Without a retained authenticated original, a recorded tool preview stays a
preview. Its truncation marker makes search incomplete even for a negative
query. Neither source establishes that a historical claim is still true today.

New oversized host output in recorded CLI turns uses a 4,000-character preview
after its full text and integrity manifest are saved. The original spill
threshold remains 40,000 characters; smaller results are unchanged. This limits
repeated preview cost without removing the exact source searched here. Set
[`compaction.retainedToolPreviewChars: 0`](context-and-compaction.md) to keep
the earlier preview size. Records already written are never rewritten, and failed
retention falls back to the ordinary output budget.

## Exact retained text

`read_conversation({ seq, part?, byteOffset? })` returns exact retained text rather
than a summary or search excerpt. `part` defaults to zero; compaction events
can contain several textual messages with different part indices. The tool
shares search's host-bound ownership and filesystem checks. It never reads
caller-selected paths or follows a spill path from a record.
After an indexed, snapshot or live search returns a match, the CLI temporarily retains its
authenticated SDK address under this conversation's root, tenant, project,
session, turn, sequence and part. A following read can go directly to that source
instead of locating the same record again from the first index page. It still
reopens the source, checks current ownership and authenticates the record and
requested text; a changed closed source is refused, not silently substituted.
Only locations are retained, not text or authorization. The process holds at most
128 locations for ten minutes, and releases them when the conversation host closes.
After expiry, eviction or process restart, the durable sequence/part address
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
If a former live owner is gone, a fresh read can locate its settled turn or
nonterminal snapshot normally; an already-issued live read cursor
retains its existing owner requirement.

Cold address lookup verifies the returned sequence and part before reading.
Read pages must match the requested byte position, fit the remaining allowance
and have UTF-8 byte counts consistent with their continuation and total length.
Cancellation is checked again after an awaited page returns, so a custom reader
that ignores the signal cannot turn a cancelled request into successful text.

Supply the optional `byteOffset` from search to start near a match, or omit it
to read from the beginning. Copy the returned value exactly: rounding or estimating
a byte position can split a UTF-8 character and is refused. The read tool's error
guidance points back to the exact search position without exposing private paths.
Repeat that initial offset unchanged with subsequent
cursor calls. The tool returns `offset` in UTF-16 units, not bytes. A
record without a character index is read sequentially from zero.

Each call scans at most 8 MiB and returns at most 6,000 UTF-16 code units,
without splitting surrogate pairs. `text` may be empty while scanning toward
the target. Continue with `nextCursor` and the same address until `complete`
is true. `offset` and `totalChars` use UTF-16 code units; `complete` means the
selected retained part has been delivered, not that the entire original tool
output or conversation was retained. Indexed reads set `retainedPreview` from
the selected source. `totalChars` is omitted when unavailable.

The 4 MiB record cap still applies. Cursors share the bounded ten-minute cache
and file-snapshot checks used by search. A read cursor is separate from a search
cursor. Closing the host releases both kinds of cursor. After restart or expiry, begin again from the durable address without
a cursor. Text pages revalidate their source record, so reading many pages of
one large record trades repeated bounded I/O for avoiding an in-memory
payload cache. Indexed spill reads verify just the selected chunks and manifest.
Both tools remain ready when deferred tool loading is selected. Stateless
headless invocations without a host-owned conversation do not acquire these tools. Unrecorded bytes and binary attachments are not reconstructed.

## Terminal presentation

Successful archive calls show compact source and coverage summaries in the TUI.
Search displays the number of matches on this page, incomplete traversal and
unavailable turns, with at most three shortened excerpts. It does not turn an
empty page into proof of historical absence. Read distinguishes a partial page,
lookup still in progress, a final page starting at a later offset, and a selected
retained part returned from its beginning. These are delivery states, not task
completion or truth judgments.

A flagged preview stays visible even on a final page: the original may be
incomplete. Recorded producer kind and tool error status are shown separately
from retrieval success. Thus a successful archive read can display “Original
tool reported an error”; missing tool status remains unknown. Source labels
come from response metadata, not claims inside the excerpt.

Ctrl+O opens the complete returned JSON with formatting, including addresses,
continuations, source metadata and exact text strings; the compact excerpt does
not replace it. The model-facing receipt and durable event output are unchanged.
The output window uses a single-line heading for multiline summaries. Retrieval
errors and unrecognized response shapes keep the existing fallback display.

The [presentation control](../../research/conversation-evidence/presentation-results.md)
uses real archive tools through a resumed CLI process and a 100×28 terminal,
with scripted inference. Screen tests also cover 40-column terminals, empty
lookup progress and incomplete searches without a continuation.

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
honored a mid-turn request to include the event sequence. Its reported inventory
count (20,564 tool-output characters, including JSON metadata) matched the
recorded tool outputs. There were no tool errors; the turn used 55,715 model
tokens across six requests. This is integration evidence, not a measured
improvement over an inventory-disabled baseline.

The process was then closed and the conversation projection was explicitly
replaced with a summary containing no UUIDs. After a real TUI restart, the same
durable address returned the first UUID correctly in one read call. This tests
archive independence from the projected history; it does not claim that an
automatic model compactor chose that summary. Unit tests additionally cover
Unicode page boundaries, scoped cursors, multipart compaction records,
scan-budget continuation and retained-preview reporting.

On 2026-09-12, a separate-process `run --resume` (now `exec --resume`) with Luna/low recovered two
random UUID identifiers absent from a 40,000-character tool preview and the
replacement conversation summary. The original workspace file had been
manually replaced. It used one search and one exact read, no workspace replay,
and 21,922 unpriced subscription tokens (50,000-token/10-iteration ceiling).
A second attempt against the final source repeated that result with 21,761 tokens.
The initial read used a scripted provider through the real CLI Session;
recovery used the live provider. This is one integration experiment, not a
benchmark gain. [Reproduction and measurements](../../research/conversation-evidence/results.md)
distinguish that experiment from deterministic command and compaction checks.

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
