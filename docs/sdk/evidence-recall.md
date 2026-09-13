---
type: Reference
title: Automatic conversation evidence recall
description: Bounded historical passage discovery and candidate ranking in request-only context.
resource: packages/sdk/src/run/evidence-recall.ts
tags: [sdk, context, evidence, memory]
status: draft
---

# Automatic conversation evidence recall

`createEvidenceRecallStep` is an experimental, opt-in `PrepareStep`. The host
binds a tenant, project and conversation, and supplies a read-only `retrieve`
callback returning authenticated passages. The step ranks the returned pool
and adds selected text to [request-only step context](step-context.md), after
history. It preserves earlier stages' context and leaves system policy and
durable messages unchanged. By default it makes no model calls. Optional query
resolution uses run-metered inference; retrieval never executes an action to
recreate its output.

The callback receives the invoking `runId`, up to 16 literal terms, an
`AbortSignal`, `maxReadBytes: 8388608` and `maxCandidates: 24`. It must enforce
these limits, verify invocation ownership and source integrity, and return
`EvidenceRecallBatch`: `candidates`, accounted `scannedBytes` and `incomplete`,
with optional `excludedToolResults`.
The SDK checks the returned bounds and every candidate's conversation scope;
it cannot enforce the callback's internal I/O or authenticate invented bytes.
Use [retained evidence sources](retained-tool-evidence.md) for authenticated local
observations. A custom host is responsible for equivalent guarantees.

An incomplete batch may include up to four `EvidenceRecallContinuation` hints:
`toolName` and a flat `input` object with string, finite number, boolean or null
values. Names are bounded to 128 characters, input keys to 64, entries to 16 per
call, and the combined JSON to 2,048 characters before escaping. Invalid hints
reject the pass. The host must mount read-only tools which validate ownership,
cursor lifetime and source integrity again on execution. A hint grants no new
authority, performs no tool call and keeps no source bytes alive.

When the kernel exposes a live writer, `EvidenceRecallRequest.captureRunEvidence`
captures completed events from that invoking run. The wrapper binds capture to
the recall deadline and parent cancellation, and rejects new captures after the
recall pass ends. Stores without the capability return `undefined`. This does
not authorize discovery of another run or extend an expired invocation.

Each `EvidenceRecallCandidate` carries `scope`, event `seq`, textual `part`,
`source`, `retained`, `excerpt`, optional `toolName`, `isError`, stored-event `recordedAt` and UTF-8
`byteOffset`, plus optional `excerptComplete`. Excerpts are at most 512 UTF-16 units and are emitted without
rewriting identifiers or silently clipping their text. `full` describes what
the archive retained, not the completeness of the excerpt or success of the
original action. Every rendered passage retains its origin and preview/error
state. Invalid candidates, including irrelevant candidates from another
conversation, reject the entire pass.

`excerptComplete: true` attests that the excerpt covers an entire full-retained
text part. `false` means partial text or a retained preview; absence means
unknown. The built-in sources derive this from validated UTF-8 source bounds.
Custom retrieval callbacks must supply accurate coverage; the step cannot
independently inspect their source. A true value with preview retention or a
nonzero supplied byte offset rejects the batch, as does a non-boolean value.

Selected passages and already-visible source references preserve the flag.
Whole, partial and unknown copies remain separate even when their text and
address match. Bounded context guidance explains that re-reading an unchanged
whole part adds no text or independent support; completeness does not prove
claims or exhaust history. The flag and guidance share the existing context
character allowance, and make no additional inference or archive read.

## Selection and limits

The step prefers `latestUserMessage`, then the host's optional `query`, then
the last eligible operator message in visible history. Runtime context such as
task results, project instructions and earlier recall does not become a query;
steering and goal-round input remain eligible. Discovery uses Unicode word
tokens from the final 4,000 characters, with a small English/Turkish glue-word
filter. Literal spelling is preserved for search. There is no stemming,
translation, synonym expansion or embedding model. Other languages may need a
host retrieval strategy that suits their text.

Set `resolveQuery: true` to resolve conversational references before retrieval.
The default remains `false`. With the kernel's optional
[`generateText` preparation capability](step-context.md#bounded-preparation-inference),
a tool-free call asks the selected model whether the current question is
self-contained, refers to previous text, or needs no search. This addresses the
[observed referential failure](../../research/conversation-evidence/referential-results.md);
the [follow-up CLI trials](../../research/conversation-evidence/resolved-query-results.md)
record two exact historical answers and one remaining current-answer spelling
failure. This is not a guarantee that the model understands every reference.

Planning receives only the current question (at most 1,000 UTF-16 units) and up
to six visible reference excerpts. Operator/assistant messages use their last
600 units. Within that same allowance, the latest nonempty system message marked
with `source.type: 'compaction-summary'` may supply its first 600 units, preserving
task information near the beginning. This is explicitly derived reference data,
not an original observation or a new instruction. Prose headers alone do not
qualify. At most one summary is selected, without splitting a UTF-16 pair.

History selection examines at most 64 entries before the current operator
boundary; tools, private reasoning, ordinary project/system policy and runtime task
context are excluded. If the six newest eligible ordinary messages are all assistant
updates, the same 64-entry scan continues looking for the nearest preceding
operator request. When found, that request replaces the oldest selected update:
the planner still receives at most six excerpts of at most 600 units each. If a
summary occupies one slot, the nearest operator remains alongside up to four
recent updates. This
prevents progress commentary from disabling reference resolution while its
operator request is still inside the scan allowance. It does not restore a
request removed by compaction or enlarge the history scan.

When the retained `latestUserMessage` is the same object as a visible message,
that message locates the boundary. A retained input can instead live outside
the visible array, as with tool-result steering or checkpoint hydration. In
that case the planner considers the bounded recent visible history, without
mistaking an older equal string for the new input. This view is not guaranteed
to precede the original acceptance time: no missing position is invented from
text or timestamps. Hosts without retained-input metadata keep the existing
text boundary fallback.

It requires an operator message or marked compaction summary in that selected history. Missing inference,
missing prior context or longer questions keep literal retrieval. The planner
cannot discover a referent that is absent from this bounded visible history.
The [progress-heavy CLI comparison](../../research/conversation-evidence/query-history-results.md)
records a false current-file answer, exact historical recovery after selection
was fixed, and later query-planner failures, using separate reopened CLI processes.

The planner receives up to 256 numbered word spellings from the supplied text,
using the same tokenizer as candidate discovery. Current-question words come
first, followed by recent operator messages, the selected summary, then recent assistant messages.
Exact spellings are deduplicated; punctuation-separated filenames and identifiers
have separate word entries. Words longer than 256 units are not offered.

Vocabulary rows share the preparation capability's existing 12,000-character
system-plus-prompt allowance, including JSON escaping. The host omits rows that
do not fit, and skips inference if the history payload alone is too large.
`omittedTokens` in the planner input counts distinct visible spellings not
offered because of length, count or character limits. It is not an archive
coverage count. A plan can only select offered IDs; missing entries are not
invented. This does not increase the history or archive scan allowance.

A contextual plan selects at most 16 integer word IDs and provides three or
fewer exact quotes of at most 200 units each. IDs resolve to host-held source
spellings, so the planner cannot inflect or translate a selected word. They are
local to that input and grant no archive authority. Each selected word must still
occur in the current question or a cited quote, and every quote must occur
verbatim in the supplied history. Unavailable IDs and ungrounded quotes fail
the optional interpretation; no invalid selection is silently discarded. This selects
search units only, never rewrites source text or a model's final answer.

The resulting `queryResolution` metadata records resolved word strings,
positive `omittedTokens` when applicable, temporal interpretation and
quoted message positions in the visible message array used for preparation.
Summary-based quotes retain optional `source: 'compaction-summary'` alongside
their actual `system` role, distinguishing them from original operator words.
These are references
to visible conversation, not authenticated archive addresses or proof of truth.
They share the existing added-context character allowance. Grounding validates
spelling and source inclusion, not semantic relevance.

The [long-history CLI experiment](../../research/conversation-evidence/long-history-results.md)
uses 18 intervening turns, real manual compaction and process restart.
It distinguishes explicitly named historical questions from unnamed references;
retaining a summary in planning does not by itself prove correct interpretation.

The [indexed-query CLI trial](../../research/conversation-evidence/indexed-query-results.md)
compares the observed spelling failure with selection from numbered source words
and exercises historical, current-state and new-topic requests. It draws on
query resolution by term selection, without reproducing a trained research model
or establishing a general retrieval success rate.

Self-contained or new-topic plans without lexical focus keep the current literal query. Present-state
plans never expand with historical terms; fresh source observations remain the
main model's responsibility. When the planner identifies competing referents,
an `ambiguous` plan selects no search terms and cites up to three exact history
quotes. The host validates those quotes and emits a bounded, request-only
planning note instead of fetching an arbitrarily selected subject. It asks the
main model to check the references and clarify if needed; it is explicitly an
interpretation that may be mistaken, not retrieved evidence or a new operator
instruction. Quote inclusion does not prove semantic ambiguity.

This note preserves earlier prepared context, uses the same character allowance
(including JSON escaping), and is omitted entirely if it does not fit. It never
changes history or system policy, grants no tool authority, and stops on parent
cancellation. A new operator input invalidates the cached interpretation. A
missing named subject should retain literal discovery, rather than be treated as
competing referents or proof that the archive has no matching record.
The [reference-context CLI comparison](../../research/conversation-evidence/reference-context-results.md)
records the silent-abstention failure, the corrected clarification decision,
and remaining unrelated-passage and repeated-output behavior.

### Grounded subject focus

With query resolution enabled, the same planner may select up to four
`focusIds` from its selected `termIds`. These identify distinctive subject
words likely to occur in an observation, rather than generic field words or a
filename merely naming its container. A direct plan with focus must ground all
selected terms in the current question and carry no history quotes. A contextual
plan still requires exact supporting quotes. Focus IDs outside the selected
terms reject the optional stage. Ambiguous and no-search plans cannot carry
focus; present-state plans continue using current literal discovery.

The SDK resolves IDs back to offered spellings as `queryResolution.focusTerms`.
It passes those words as `EvidenceRecallRequest.terms` to the existing bounded
host retrieval. A candidate must contain **any** focus word, matched using the
same case-insensitive Unicode token keys as ranking. This is not a phrase or an
all-words condition. The full resolved query still ranks the eligible passages.
Every returned candidate is validated for bounds and conversation scope before
filtering, including an off-subject candidate a custom host should not have
returned. Filtering confers no authority on a source and never edits its bytes.

`queryFocus` records the focus words, `matchedTerms` observed in bounded
candidate excerpts, and `excludedPassages`, the number of grouped new or visible
passages filtered out locally. It is not a count of excluded archive records,
global term coverage, relevance confidence or proof of absence. An empty
focused scan still supplies this bounded metadata when it fits, alongside the
host's unchanged `incomplete`, exclusion counts and continuation hints. The
note explicitly disclaims absence and permits different explicit archive
queries. No broader query is silently run, no extra scan budget is allocated,
and no state-changing action is replayed.

This focus is a fallible planner interpretation. It can omit a useful passage
that expresses the subject differently or whose bounded excerpt lacks the
subject word. Source grounding verifies spelling, not that the selected word
is a good subject. Explicit `search_conversation` and `read_conversation` retain
their existing semantics, scope checks and access to the unfiltered archive.
The metadata shares the existing context allowance; an oversized block is
dropped rather than bypassing that limit. Without `resolveQuery`, without a
valid focus, or outside the planner's bounded history window, existing literal
retrieval behavior remains.

See the [focused-query experiment](../../research/conversation-evidence/query-focus-results.md)
for the common-field failure, archived-history controls and live sample limits.

A `none` plan skips optional recall without a note. Malformed or ungrounded
plans remain failed-stage diagnostics. With enough context room, retrieval still
runs once using the unchanged current-query tokens and the same byte, candidate
and deadline limits. No terms or references from the rejected plan are used.
Temporary context identifies `status: "unavailable"`, `stage: "query_planning"`,
`reason: "failed"` and `fallback: "literal_query"` alongside any fully validated
retrieved records. The note does not claim a referent or temporal intent was
resolved. No plan text, exception body or source data enters the note itself.
The main task and explicit archive tools remain available. The previous operator
query is never used just because literal retrieval was empty.

One plan promise is cached for the same run and operator-message identity, also
keyed by question text. New runs or steering input invalidate it. A failed plan
is not retried on every iteration. Evidence bytes are still retrieved and
revalidated on every pass. This cache is local to the hook, not durable memory.
The planning call permits at most 512 output tokens and ten seconds, sharing the
run's provider chain, token ledger and cancellation. Those tokens count toward
the run; the subsequent retrieval deadline is separate. These are bounded
preparation costs, not free retrieval or a hard provider billing ceiling.

Duplicate source/excerpt addresses with equal metadata are omitted. Exact passages
already visible in history or an earlier stage's `prepared.system`/`prepared.context`
contribute quoted source references instead of new passages. Tool text blocks
have the same visibility behavior as string-valued messages. Each text block is
checked independently: joining blocks would invent visible text across their
boundaries. Image/document payloads, filenames, media types and private reasoning
do not establish textual visibility. Earlier context is preserved and still
counts against the runtime's remaining budget; it is not added to durable history.

This is visibility at this preparation boundary, not a guarantee about later
stages or provider transformations. Visibility grants no archive authority:
every candidate, including visible text, still passes the full scope and metadata
validation. Available references retain their exact quotes, error/preview status
and recording times. Visible text no longer consumes a new-passage slot just
because its message uses the block form. The [CLI comparison](../../research/conversation-evidence/visible-blocks-results.md)
records missing evidence displaced by that representation mismatch.

Remaining candidates with exactly equal text,
`source`, `toolName`, `isError`, `retained` and `excerptComplete` share one passage. Missing status
is distinct from explicit success. Letter case, whitespace and changed identifiers
are preserved; this is not semantic similarity or automatic conflict resolution.

For non-summary candidates, the best positive BM25 match stays first. One
positive match from each other producer kind follows, then remaining matches
in score order. This prevents several distinct model claims from occupying
all slots when a matching tool record is already in the bounded candidate pool.
`message_completed` and `compaction_shed:assistant` share one producer kind;
custom source labels all share `unknown`, so invented labels cannot reserve
extra slots. This does not guarantee one passage per kind when the slot or
character budget is too small. When the highest-scoring passage fits, one-slot
selection remains unchanged.

Known derived summaries (`source: 'compaction_shed:summary'`) remain last, with
their own BM25 statistics, so their repeated vocabulary cannot change other
records' scores. Summaries still fill remaining slots or serve summary-only
archives. The same ordering is applied separately to already visible quotes.
Neither ordering nor producer diversity establishes relevance, truth,
independence or chronology. Explicit archive searches retain their original
traversal order. No new page, model call or read allowance is added.

Selected passages and `visibleEvidence` entries add a `recordKind` label derived
only from the validated `source`, never from the excerpt's claims:

| Source | Record kind |
| --- | --- |
| `message_completed`, `compaction_shed:assistant` | `assistant_message` |
| `tool_completed`, `compaction_shed:tool` | `tool_result` |
| `compaction_shed:user` | `user_message` |
| `compaction_shed:summary` | `derived_summary` |
| `compaction_shed:system` | `system_message` |
| Other host labels | `unknown` |

`user_message` identifies a user-role record; that role may also carry
runtime-generated context. It does not authenticate human authorship.
`system_message` identifies a stored role, not instruction authority.
An assistant record establishes what the model said, not what a file contained
or whether an action succeeded. Tool results can themselves quote claims or
retrieved text. These labels identify the producer and confer no authority on
content. When eligible assistant records exist, bounded `recordKindGuidance`
asks the model to attribute unsupported prior statements as claims and check
relevant original observations. This guidance is not a verifier or a guarantee
that a model will obey it. Host retrievers still own source integrity checks.

The [source-origin CLI controls](../../research/conversation-evidence/record-origin-results.md)
record the model treating its own unsupported claim as an observed file value,
and compare bounded source selection and attribution after this change.
The earlier [summary comparison](../../research/conversation-evidence/summary-evidence-results.md)
records a separate case where derived summaries displaced an original.

If a partial CLI discovery page includes known summaries, the host may spend
its existing refinement page on the same terms with
`excludeDerivedSummaries: true`. This changes source selection before passage
slots are consumed, allowing retrieval to traverse repeated summary records.
It retains the general cursor and already returned summaries, so a summary-only
archive can still contribute evidence. When the focused scan finishes, any
remaining pages resume the general cursor. This takes the place of lexical
term refinement for that source class; it does not add another scan or page.
The combined four-page and 8 MiB limits remain. Large excluded spans can still
exhaust discovery; the focused and general continuations remain distinct.

Optional `EvidenceRecallBatch.excludedSummaries` carries nonnegative safe-integer
scan-visit counts into bounded context with source-selection guidance, even when
no passage is returned. It is not a unique-fact count or proof of absence. The
[CLI discovery experiment](../../research/conversation-evidence/summary-discovery-results.md)
compares the previous twenty-summary failure and verifies recovery past seventy
summaries, including an empty filtered index page.

`recordedAt` is optional recorder wall-clock Unix milliseconds, not fact time.
Explicit callback values must be positive integer milliseconds within the JavaScript
Date range; omit unknown times rather than returning a zero sentinel. Invalid
values reject the batch. Built-in archive sources derive it from the validated
event, including on exact reads. Compaction copies carry the copy event's time;
no original observation date is invented. Clocks can differ or move backwards.

The representative passage and each included `otherOccurrences` entry preserve
their own recording times. Equal text still shares one passage and receives no
extra ranking votes. Time metadata shares the existing character allowance.
`additionalEvidence` remains a plain read address; reading it returns the time.
Already visible exact text is suppressed from new passage text, but its validated
sources appear separately in `visibleEvidence`. Each entry binds its exact bounded
`textQuote` (at most 512 UTF-16 units) to a directly readable `address` (`runId`, `seq`, `part`, optional `byteOffset`), optional
`recordedAt`, `source`, optional `toolName`/`isError`/`excerptComplete`, and `retained`. The quote
repeats only the authenticated candidate excerpt needed to make the association
explicit; it does not reload the full source or establish that a
preview is complete. Matching text may occur in several visible messages, so the
list is not a mapping to their order. Read an entry's `address` with the host's
archive tool for text beyond the quote.

Visible candidates are ranked separately so they do not change new-text BM25
statistics. Positive-score candidates are grouped by the existing exact-copy
rules, then equal quote/reference metadata is deduplicated. One representative per distinct
quote is offered before extra occurrences, so copies cannot consume the whole
reference allowance ahead of a distinct visible correction. Visible quoted references
and new passages share `maxPassages`; new text takes priority. Extra references
can therefore be omitted even if characters remain. `omittedVisibleEvidence`
counts references from this bounded pool that did not fit, not total historical
occurrences. Source time, error and retention remain distinct; missing metadata
is not filled in from visible text. References are revalidated each pass, even
when similar metadata was previously visible. Quoted references themselves add no current-state assertion; optional query
resolution labels an interpretation separately.
Quoted references do not validate a model's final free-form answer. The
[visible-source CLI experiment](../../research/conversation-evidence/visible-evidence-results.md)
records both the improvement over unquoted references and an unresolved exact-code
copy error from a live low-effort model.

The [recorded CLI comparison](../../research/conversation-evidence/recorded-time-results.md)
checks both date orders with a small model at low effort.

Distinct passages are ranked using BM25 with `k1=1.5` and `b=0.75`, using statistics
**only from those groups in the bounded returned pool**, not the whole archive.
Copies therefore cannot change term frequencies across documents or consume
every passage slot while a distinct correction remains in the candidate pool.
Zero-score passages are omitted; ties retain first-discovery order.
The score measures lexical relevance, not confidence, truth or freshness.
The mathematical starting point was inspected in this pinned
[conversation search implementation](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py).
These constants are not claimed to be optimal.

Candidate discovery can limit ranking quality before scoring starts. The CLI
uses the SDK's optional token mode for automatic discovery, so `in` inside
`Packing` no longer consumes a match slot that the scorer would then reject.
Discovery and scoring share token units and lowercase keys. Host callbacks
choose their own retrieval semantics; a custom literal source can still have
this mismatch. Genuinely frequent whole-word matches can also consume the bounded
candidate allowance before a relevant passage is visited. A small
[candidate-discovery ablation](../../research/conversation-evidence/candidate-alignment-results.md)
records the original limitation and alternatives. Token alignment addresses
substring pollution, not arbitrary candidate ordering or global relevance.
Explicit literal search still supports substrings.

The CLI's automatic discovery excludes successful `search_conversation` and
`read_conversation` outputs before they occupy candidate slots. These tools quote
archived observations; repeated successful retrieval is not another observation
of the original state. This host policy uses the SDK's generic
`excludeSuccessfulTools` source option; the SDK does not hardcode CLI tool names.
Errors and unknown source/status remain. Compacted results are identified only
when the SDK can pair the call and response unambiguously in that same record;
older archives without paired metadata and legacy unindexed compaction text
remain unknown. This is not semantic deduplication: unknown or differently
rendered quotes can still occupy candidate slots.

A retrieval callback may report nonnegative safe-integer `excludedToolResults`.
The step validates it and, when positive, includes the count and explanatory
guidance in its bounded context. Counts are scan visits, so a focused pass may
count the same record again. They are not unique facts or errors, and do not
replace `incomplete` or `omittedPassages`. An exclusion-only block can be returned
without passage text, within the same character ceiling. The SDK source defaults remain unfiltered. The CLI's new literal searches omit
successful archive-retrieval copies by default and offer
`includeRetrievalResults: true` to inspect them. Explicit cursor continuations
retain their source filter.
The [CLI comparison](../../research/conversation-evidence/retrieval-echo-results.md)
measures a correction initially hidden behind retrieval copies, including the
compaction case, without claiming a general memory benchmark improvement.

`refineEvidenceRecallTerms(terms, excerpts)` is an optional, pure SDK helper
for host discovery. It compares the same lowercase token keys in a bounded
excerpt pool with the original query terms and returns only uncovered terms,
preserving first spelling and order. It returns `undefined` if none or all of
the terms were observed; case variants do not create additional terms. It
accepts 1–16 single-token terms of at most 256 UTF-16 units each and 0–24 excerpts
of at most 512 units each; invalid input throws. It performs no I/O, model call,
semantic inference or archive-wide frequency calculation. Its coverage is of
these excerpts only, not proof that a query aspect is answered or absent.

The CLI may spend an already allocated page on this strict subset when the
broad search has a continuation. There is at most one focused scan for the
current writer and one for earlier invocations. A focused scan starts from the
beginning under the same scope, token matching, cancellation and shared byte
ceiling; its reads are charged again. If it completes while pages remain, the
host resumes the preserved broad cursor. Exhausting the subset cannot exhaust
the original query. This can reach a rare query term behind frequent-word
matches, but cannot guarantee globally optimal candidates; an excerpt pool
covering every query token will not trigger refinement. No stop words are added.
The [measured CLI comparison](../../research/conversation-evidence/refined-discovery-results.md)
records the recovery improvement, increased I/O and remaining counterexamples.

The first-discovered occurrence supplies each passage's `runId`, `seq`, `part` and optional
`byteOffset`. Equal observations retain their additional addresses under
`otherOccurrences`; `omittedOccurrences` counts extra addresses from this bounded
pool that did not fit. Neither field counts every occurrence in the archive.
Distinct passage text and one address per passage take priority over extra
addresses. Repetition does not establish independent corroboration. Event `seq`
orders observations within one run only; presentation order is relevance, and
run UUIDs do not establish chronology between runs.

The metadata retains `incomplete` even when no passage was selected, including
when all matches are already visible. An empty or bounded scan is not proof of
absence. Available continuation calls appear as `continuations`, with
`omittedContinuations` counting hints that did not fit the character allowance.
`omittedPassages` counts eligible distinct passage groups from this returned
pool which were not selected, either because of `maxPassages` or the character
ceiling. It excludes visible text, exact copies and zero-score groups; it is not
a count of all relevant records in the archive. `incomplete` still describes
source traversal, so it can be false while `omittedPassages` is positive.

When text is omitted, `additionalEvidence` contains as many representative
`runId`/`seq`/`part`/optional `byteOffset` addresses as fit; `omittedAddresses`
counts omitted passage groups whose address did not fit. These addresses reuse
the validated candidate scope, disclose no omitted text and grant no authority.
A host archive tool must revalidate scope and source on a later read. Their
order remains relevance, not chronology. SDK callers supply their own archive
read tools; the CLI accepts these addresses through `read_conversation`.
A [recorded CLI comparison](../../research/conversation-evidence/selection-coverage-results.md)
shows exact recovery of a matched receipt omitted by selection.

Distinct text takes priority over traversal hints, then omitted-passage
addresses, visible-text source references, and extra addresses of selected exact duplicates. All share the
original character ceiling. An omission-only block is retained even if no whole
excerpt fits and source traversal was complete. A complete scan with no new text can still add visible-source references or their
omission counts. A scan with no eligible text, references, exclusions or traversal omissions adds no context; a context budget too small for the framing skips
recall altogether.

Defaults are four distinct passages and 6,000 added characters, including framing and
escaped JSON; callers may set `maxPassages` up to eight and `maxChars` up to
12,000. The context budget can lower that allowance. Whole passages which do
not fit are omitted. The default deadline is 1,000ms (`timeoutMs`, at most
10,000ms). Parent cancellation and deadlines abort retrieval. Late results
are discarded, and another hook using the same callback skips retrieval
until the original operation settles. An uncooperative callback therefore
cannot accumulate overlapping reads through this hook. Timeout/error uses
the runtime's existing prepare-step diagnostic and fail-open policy, with a
temporary availability note (`stage: "retrieval"`, `reason: "timeout"` or
`"failed"`). While an earlier uncooperative read remains unsettled, later passes
report `reason: "pending"` without launching overlapping retrieval. The note
never includes rejected candidates, paths, raw errors or invented evidence.
Parent cancellation still rejects without a note and cannot revive model work.

Availability notes share the configured context allowance. The kernel also
checks remaining request room before appending a failure note; no room means no
note. Prior stage decisions survive and ordinary thrown callback errors are
still diagnostic-only. Direct callers of the recall callback still receive
rejections for failed planning/reads; the query loop projects the safe status
and any fully validated literal fallback context. The note reserves space inside
the same character allowance before selecting passages. If status plus bounded
evidence framing cannot fit, planning failure skips retrieval as before. An empty
fallback scan still reports its traversal metadata; it is distinct from planning
availability and does not resolve a missing referent. A failed fallback read
reports retrieval unavailability and contributes no candidate text. Parent
cancellation never starts fallback work.
Successful later passes replace the status through normal per-step preparation.
The [failure experiment](../../research/conversation-evidence/availability-results.md)
records actual CLI and terminal checks, including a live model that ignored this
status and selected current data for a past-observation question. Availability
reporting does not certify the model's recovery decision.

Every request revalidates its source; recalled bytes are not cached for a
later step. The immutable bound scope prevents changing an options object
from changing the conversation. A host should reuse a stable callback per
conversation and reject stale run ownership before and after asynchronous I/O.

## Historical and current facts

The context labels passages as historical records and untrusted reference
data, not instructions or verified current state. Producer labels distinguish
assistant claims from tool results without certifying either as true. A past file observation may
answer what was seen earlier. It cannot establish what is in the file now.
Current facts still require sufficiently fresh evidence. Missing, bounded or
unavailable history is not proof of absence; explicit archive search/read
tools remain necessary for details outside the automatic pass.

When reporting a source identifier, its spelling must remain exact. A requested
text transformation produces a derived value instead: lowercasing a recorded ID
for display does not change the archived ID or establish new workspace state.
Recall guidance distinguishes these operations without rewriting retained text
or installing a generic answer-rejection policy. The [CLI copy/transform
experiment](../../research/conversation-evidence/copy-intent-results.md) records
natural-language failures and controls against falsely rejecting legitimate
transformations; these are bounded trials, not a general fidelity guarantee.

The [CLI option](../cli/context-and-compaction.md), enabled by default in recorded
conversations, uses this live capability for
up to two pages before visiting earlier invocations. It can recover original
retained text after compaction within the same running invocation. The combined
pass still has four pages and an 8 MiB accounted-read ceiling. Explicit tools
remain available for later pages, longer excerpts and exact sequential reads;
automatic recall does not claim an exhaustive search of long-running history.
The SDK does not install this step automatically: other hosts still choose
whether to attach it and whether to enable model-assisted query resolution.
Within one automatic candidate page, the CLI can cross completely searched
matching runs as well as empty runs, while respecting the shared byte and output
limits. Partially traversed SDK pages keep their continuation boundary. This
allows distinct evidence from several small invocations to enter the bounded
candidate pool instead of spending one automatic page on each run. It does not
expand the four-page budget or claim exhaustive archive coverage.

The CLI's directory discovery continues across batches of 100 entries, so that
limit no longer permanently excludes later runs. The automatic four-page pass
can still stop before discovery or text traversal is exhausted; explicit search
continuations remain necessary beyond that allowance.

When traversal has another page, the CLI supplies up to four continuations:
focused before broad within the live writer, then focused before broad within
earlier invocations. Each keeps its own query and omissions. The model can pass its opaque `cursor` to
`search_conversation` without reconstructing the automatic multi-term query.
Automatic passes still revalidate from the beginning; the explicit read-only
continuation provides access beyond that bounded pass without an action replay.
