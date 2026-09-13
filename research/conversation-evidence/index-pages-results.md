# Fill public search pages across internal index boundaries

2026-09-13. Base: `bd4bd2e5`. [Recorded observations](index-pages-results.json).

## Evidence and implementation

The failed unnamed follow-up in the [long-history experiment](long-history-results.md)
returned two compacted message matches after accounting for 179,070 read bytes,
then handed control back to the model because an internal index page ended.
The public request allowed ten matches and 8 MiB of reads. Guidance already
explained cursor continuation, but the model started new searches instead.

The CLI now packs internal SDK pages into the existing public response. A call
can resume an advancing internal cursor up to seven times, shared across runs.
It still reserves serialized output before asking for matches, respects the
requested match limit, reads at most 8 MiB and returns at most 12,000 bytes of
matches. This is additional bounded host work, not another model decision.
An unchanged internal cursor yields without exhausting the seven-resume budget.
Exhausted runs can still advance within the single directory-discovery page.

Every internal page re-enters scope and source validation. If a later operation
fails, the response removes the matches it has accumulated from that run;
matches from other runs remain. Unknown read cost still charges the remaining
allowance. Cancellation propagates instead of returning partial success. Run
counts are distinct within a public response, while bytes and exclusion visits
include repeated internal operations. Omission status survives exhaustion and
public continuation. Durable addresses and exact-read limits are unchanged.

Pydantic AI harness's [conversation search toolset](https://raw.githubusercontent.com/pydantic/pydantic-ai-harness/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py)
ranks across the selected persisted corpus while rendering context within each
match's run. That separation is relevant here: storage organization need not
force a model round trip. Namzu continues to use incremental bounded discovery;
this change does not import corpus-wide BM25 ranking or remove pagination.

## Reproduction and storage measurements

The [driver](index-pages-cli.mjs) uses an existing real CLI Session seed: a
scripted provider calls the actual file-read tool once, and the runtime retains
the original oversized output. Random tracking and destination identifiers are
absent from the visible preview and replacement conversation projection. The
workspace manifest is replaced with a short notice.

The fixture then constructs a scoped closed compaction archive with 136 text
messages before the original run in discovery order. Its first two messages
mention DELTA without its identifiers; the others concern unrelated work. This
archive spans three internal index pages. It is a controlled archive fixture,
not a new live compaction measurement. The previous report covers actual
`Session.compact` and restart.

Each storage pass searches for DELTA with a limit of ten and follows public
cursors until it reaches the original. It then performs an exact archive read.

| Build | Pass | Public calls to reach original | Matches per response | Accounted search bytes |
| --- | --- | ---: | --- | ---: |
| Base (`tiGzDs`) | Cold | 3 | 2, 0, 2 | 538,821 |
| Base | Warm | 3 | 2, 0, 2 | 782,686 |
| Candidate (`awE1AO`) | Cold | 1 | 4 | 931,737 |
| Candidate | Warm | 1 | 4 | 1,175,602 |

Fewer public calls do **not** mean fewer bytes here. Packing keeps reading
within the available allowance instead of returning at each internal boundary;
it can inspect more of the source before returning a page that contains the
answer. These counts stop at discovery and do not represent equal exhaustive
coverage. Cold index construction and warm index reads also have different
accounting costs. This measures a model-round-trip reduction in the fixture,
not an archive-wide I/O or monetary saving.

Every page stayed inside its match, byte and serialized-output bounds. No
consumed match was lost or repeated. Exact reads recovered both originals.
All seven source files—run transcripts/metadata, original spill/manifest and
workspace file—kept their hashes. Production build fingerprints stayed stable
during each measurement.

## Live CLI and real TUI

The candidate's `--live` case (`Ib4aiQ`) reopened a fresh generated conversation
with the production CLI. Automatic recall was disabled deliberately to isolate
explicit search; the product's recorded-conversation default is unchanged.
The natural question was:

> DELTA kaydını ilk okuduğumuzdaki takip kodu ve hedef deposu neydi?

The call used Codex `gpt-5.6-luna`, low effort, four iterations, a 30,000-token
admission allowance and a 120-second process deadline. The model made one
`search_conversation` call with `limit: 20` and returned both exact identifiers
from its result. It used no workspace tool or external action. All seven source
hashes stayed unchanged. Usage was **15,120 unpriced subscription tokens**;
the reported zero cost is not a free-service claim. This is one successful
trial, not an accuracy rate or a paid before/after comparison.

The [TUI fixture](index-pages-tui-fixture.mjs) resumed the offline candidate in
a real 100×28 PTY and accepted the same question through the composer. Inference
was controlled, while the archive tools ran normally. One public search reached
the original behind the partial index, followed by one exact read. The parsed
terminal contains one search card, one read card, each full identifier once in
the answer, and an idle composer. It preserves partial-search/read notices.
`/exit` returned zero; all seven source hashes remained unchanged. This used
zero live tokens and is a tool/rendering check rather than another accuracy
trial.

Two fixture-development errors are retained separately. The first baseline
asserted four calls instead of three, overlooking the existing ability to cross
an exhausted run on the last page. The first TUI preload supplied an async
callback to the synchronous mock-provider API and exited 70 before archive
retrieval. Making that callback synchronous fixed the fixture; no production
change or source repair was needed. Neither is counted as a Namzu model failure.

## Verification and limits

The partial-index regression failed before implementation. Eight additional
tests cover bounded internal work, unchanged cursors, cancellation between pages,
later-page failure, distinct unavailable-run counting, read reservations,
escaped-output packing and exact recovery after reopening. Existing real
Session tests still cover altered retained files, foreign ownership and explicit
continuation after automatic recall exhausts its allowance. The continuation
fixture now places its target beyond the larger packed pages; it still verifies
the emitted cursor through the real tool. The actual compaction Session test
now needs one search and one read rather than two searches and one read.

The focused set passes 112 tests. Workspace typecheck, lint, build and all
package tests pass: 6,696 SDK tests and 2,986 CLI tests, with five existing CLI
skips. Lint retains warnings but no errors. Docs conformance, compiled fences,
test presence and exported signature checks pass. These are local checks;
release-only gates and publishing are not claimed.

Larger indexes, byte/output limits and unavailable sources still require
continuation. Packing can increase work per call. It does not fix semantic
query selection, establish historical truth or guarantee that a model will
follow the remaining cursor. The broader goal remains active.
