# Automatic original-evidence recall across resident admissions

Started 2026-09-13 at `ce27604e`. The SDK preparation adapter is now wired into
both CLI resident profiles and verified with actual CLI processes. The sections
below retain the prerequisite findings; the implementation audit and measurements
at the end describe the resulting change.

## Composition and reference inspection

`integrations/resident/session-step.ts` creates a fresh Session for each admitted
pursuit step. It mounts settled history and tool-evidence sources, supplies the
current objective, saved summary and ordered wake inputs, and holds normal tool
permissions. It does not supply `conversationSessions`. The ordinary automatic
recall hook in `tui/agent.ts` consequently returns no preparation step for these
admissions. Giving it arbitrary old Session IDs would be a scope change, not the
right adapter.

SDK `createResidentToolEvidenceSource` already verifies a settled claim through
adjacent agenda revisions before asking the host to resolve its invocation.
The source captures tenant, resident, pursuit and upper revision; CLI resolution
also validates attempt receipts and the run's project/Session ownership. This
is the retained substrate to reuse, without another mutable history store.

Inspected the local Pydantic AI Harness checkout at
[`c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504`](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py#L353).
Its toolset filters runs by conversation, loads each selected run's history,
ranks untruncated message text with BM25, then renders bounded display windows.
The inspected method separates discoverable text from what is displayed. Its
result-count limit is not a total-byte limit over those history loads. This is
a description of that pinned method, not every backend or current upstream.

## Read-budget prerequisite

The current resident wrapper permits separate 8 MiB history and run-source
operations, plus host attempt resolution. Merely calling it several times from
the existing 8 MiB automatic-recall callback would not enforce that callback's
aggregate contract. The composition needs an explicit allowance across history,
attempt resolution and evidence reads, including failure accounting. Matching
returned byte counts cannot prove that arbitrary host code honored its limit.

The first change adds per-call allowances to the existing low-level readers:

- Resident history search/read: 1 byte–8 MiB, default unchanged.
- Disk tool/text and captured live text search/read: 1–8 MiB, bounded by the
  source's existing configured ceiling. The live final ownership check remains
  inside the effective allowance.
- An allowance is not source/query identity. A returned continuation can be
  retried with another allowance, including after reopening, without losing the
  original scope. Failed exact reads do not return invented byte receipts.

Four added regressions failed against the base (68 existing cases passed).
After implementation all 72 tests in those three files pass. Real disk fixtures
exercise a large inline record that fits the source ceiling but not the current
call's allowance, continuation after reopening, refusal to raise a source ceiling,
exact read failure/recovery and live ownership changes. History tests verify that
a budget stop retains the unvisited settlement instead of marking it missing.

This foundation is not the complete resident adapter. The adapter still needs
combined history/resolution/evidence accounting, query selection from the actual
admitted state, preservation of historical Session/claim addresses in shared SDK
ranking, cancellation, request-only context and real resident CLI measurement.
Explicit tools must remain available for incomplete selection. No ordinary-chat
scope broadening, action replay, new history store or default resident inference
is part of this first change.

Foundation verification: workspace typecheck, build, lint and all package tests
passed (6,709 SDK tests; 3,018 CLI tests and five existing skips). Documentation
conformance/fences, signature exports, test presence and project references also
passed. Lint retains existing warnings. These are development checks, not a
complete release-gate run; no publication or live-model recall claim is made.

## Combined resident operation allowance

The next increment adds an explicit resident operation ceiling. Before history
I/O it reserves the host-declared resolution document bound and at least 1 MiB
for the archive reader. History receives the rest; its actual byte receipt then
determines the archive's remaining allowance. The returned `chargedBytes` counts
actual history/archive reads plus the declared resolution ceiling. The latter
is conservative accounting, not a measurement. CLI resolution declares the two
64 KiB start/finish document limits already enforced before reading. Existing
Session ownership checks remain; SQLite page traffic and metadata syscalls are
not a physical-disk measurement within these encoded-document counts.

Missing resolution declarations are refused before I/O. A failed resolution or
archive search without a reliable receipt consumes the remaining allowance;
failed history/exact reads still throw, requiring the caller to charge their
whole admission. A budget stop in history retains its continuation. Returned
page ownership is checked against the resolved invocation, and late results are
rejected after cancellation even if the backend ignores the signal. These
scope/cancellation checks also cover calls without the new budget option.

The initial 11 regressions failed on the previous implementation. The expanded
suite covers all four owner fields with and without a budget, invalid costs and
limits, conservative failure charging, no-I/O refusal and resuming after a
history budget stop. Real CLI Session tests cover both resident and interactive
profiles with a 2 MiB combined allowance and a replaced workspace file.

The existing process driver now has a fully scripted recovery mode:

```sh
node research/resident/tool-evidence-cli.mjs --scripted --bounded-reads
node research/resident/tool-evidence-cli.mjs --scripted --bounded-reads --interactive
```

It creates an isolated home, executes an actual original read through the CLI
resident callback, settles that admission, replaces the workspace document and
wakes the pursuit. Another process enters through `resident run`. A test-only
tool wrapper supplies the 2 MiB host option after model-input validation; the
production resolver, source, readers and accounting execute normally. Scripted
model decisions call search/read explicitly. They do not test automatic query
selection or model quality. Two different Session IDs and confirmed cleanup are
required; after completion, another CLI command must admit no extra step.
Production module hashes must remain stable. No live provider credit is spent.

At that prerequisite stage, automatic preparation, query selection, shared
ranking across original Session addresses and the live comparison still
remained. The implementation and verification follow below.

Both scripted process probes passed: two admissions in distinct Sessions, only
archive search/read on recovery, and no extra step after terminal reopening.
Each search charged 435,118 bytes and each exact read 318,228 bytes under
its 2 MiB allowance; provider usage was zero. All six production module hashes
remained unchanged during each probe. See [the compact results](operation-budget-results.json).
Workspace typecheck, build, lint and all package tests passed, along with
docs conformance/fences, signature exports, test presence and project references.
These are development checks, not all release gates.


## SDK adapter and CLI result

`createResidentEvidenceRecallStep` now reuses the conversation selection engine
through an internal authority boundary. It keeps historical Session/run IDs and
settled pursuit/revision/claim addresses, rather than pretending those records
belong to the current conversation. Ordinary conversation scope checks remain.
Each original tool address also retains its within-run sequence and byte offset.
Visible quotes, omitted passages and repeated occurrences use the same resident
address projection; no text part number is invented for tool-only evidence.

Query words are selected locally from the admitted objective, accepted wakes and
derived last summary. Categories take turns, and newer wake inputs have the first
opportunity within that category while retaining their committed indices. Each
field contributes its last 4,000 UTF-16 units; at most 16 words fit the source's
512-byte query/filter bound. These are search hints, not verified new facts.
There is no extra query-planning inference. This bounded lexical policy may miss
relevant words, unnamed referents and records outside its traversal allowance.
It is not a general retrieval-quality benchmark or a claim of perfect memory.

The SDK source retains token terms and exact successful-tool exclusions in its
opaque continuation. A cursor-only call resumes the same query after reopening;
changing a query or filter is refused. Search results report remaining traversal
as incomplete. Escaped cursor output is also bounded before exposing it to the
model, so a custom backend cannot produce an unusable oversized continuation.
The adapter allows four source pages and a combined 8 MiB charged-document budget.
All metadata, source addresses and excerpts share the context character ceiling.
Explicit archive tools remain available when automatic selection is incomplete.

Both resident context profiles mount this preparation on fresh sends. Configuring
`compaction.recallEvidence: false` retains explicit tools without this automatic
pass. The CLI supplies the four resident retrieval tool names as successful-copy
exclusions. No ordinary conversation/delegated child authority is widened, no
second history store is created, and no historical action is replayed.

### Measurements

[Compact results](automatic-recall-results.json) retain actual module hashes,
request observations, reported usage and cleanup outcomes. Each process driver
uses an isolated home/workspace. The original observation is a real CLI `read`
with authenticated spilled output and two random identifiers beyond its preview.
The scripted seed omits those identifiers from the settled summary, and the
workspace document is replaced before another process enters the next admission.

- Scripted automatic recovery passed under both context profiles. The original
  identifiers reached the first model request; the scripted response made no
  archive tool call. This proves wiring/data availability, not model quality.
- Two Luna/low probes passed. Each made two model requests and one
  `read_resident_tool` call, using the address supplied by automatic preparation.
  Neither called search or reread the workspace. Reported tokens were 12,835 on
  the initial adapter build and 12,893 on the final build: 25,728 total, all
  unpriced. Scripted seeds used zero provider tokens. These trials do not establish
  a general success rate or measured savings against another harness.
- Final-build scripted probes with changed archive bytes or a removed archive
  withheld both identifiers and settled `blocked`; neither substituted current
  workspace contents or replayed the observation. These are controlled response
  decisions, not live-model refusal guarantees.
- A real Session integration test spans three admissions and reopens the agenda:
  original and corrected observations remain separately addressed after both are
  removed from the workspace. An unverified summary claim is not promoted into
  a retrieved tool passage. The response itself is scripted.

```sh
node research/resident/tool-evidence-cli.mjs --scripted --automatic
node research/resident/tool-evidence-cli.mjs --scripted --automatic --interactive
node research/resident/tool-evidence-cli.mjs --live --automatic
node research/resident/tool-evidence-cli.mjs --scripted --automatic --changed-archive
node research/resident/tool-evidence-cli.mjs --scripted --automatic --missing-archive
node research/resident/automatic-recall-cancel.mjs
```

### Signal ownership defect found by the process test

The first SIGTERM probe failed: exit 143, two start receipts but only the seed's
finish receipt, and no model call. The resident host installed a cooperative
abort handler, but `AgentSession` also unconditionally enabled the SDK emergency
handler, which called `process.exit()` before resident cleanup finished. Relaxing
the expected exit status would have hidden missing drainage evidence.

Resident Sessions now disable SDK emergency process handlers through an explicit
host composition option. The foreground/managed resident host owns cancellation
and must drain before writing its finish/runner receipt. The final process test
interrupts a deliberately pending history source inside actual preparation:
exit 130, zero model calls/tokens, confirmed cleanup and a retained unresolved
claim. Another `resident run` refuses that claim without admitting a new step.
An interrupted callback may have no settled model stop reason; the test does not
invent one from the host exit code. Ordinary interactive emergency policy stays
at its prior default.

### Requirement audit

| Requirement | Inspected evidence |
| --- | --- |
| Current composition and pinned primary comparison | Source inspection above; Pydantic Harness checkout `c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504`; shared SDK engine and CLI session-step wiring |
| Settled tenant/project/resident/pursuit and captured revision authority | `tool-evidence.test.ts`, `tool-evidence-budget.test.ts`, `evidence-recall.test.ts`; existing history tests; returned page scope and current executor checks |
| Original versus derived claims and corrected observations | Query-source metadata; three-admission real Session test in CLI `tool-evidence.test.ts`; original archive addresses in selected/visible/omitted/duplicate records |
| Exact integrity-checked reads and unavailable artifacts | Final-build changed/missing archive process probes and existing disk/linked evidence reader regressions |
| Bounded I/O, candidates, context and query work | Combined byte receipt/reservation tests; term/filter/cursor output bounds; shared character/passages/deadline regressions |
| Cancellation and no overlapping late retrieval | SDK deadline/abort tests plus final actual SIGTERM process probe, cleanup receipt and unresolved reentry refusal |
| Cursor recovery across reopening | Resident query/filter continuation tests and real CLI-source token continuation; explicit tool input remains cursor-only capable |
| Real execution across separate admissions/process restart | Scripted and Luna CLI probes with distinct Sessions; terminal reopening admits no further step; nine module hashes unchanged within each probe |
| Bounded live inference and honest usage | Two Luna/low runs, one-step limit and per-run iteration/token bounds; request observations and complete recorded usage above |
| Public documentation, release intent and local coherent change | SDK/CLI pages, docs log and `.changeset/prepare-original-resident-evidence.md`; CLI major intent names the changed automatic-recall default and opt-out |

Final development checks passed: workspace typecheck/build/lint and all package
tests (6,748 SDK; 3,021 CLI plus five existing skips), all 264 SDK process tests,
docs conformance/fences, workflow parity, project references, signature exports
and test presence. Existing lint warnings remain. This is not an assertion that
all publishing gates ran; no push or publication was performed.

Remaining research concerns are retrieval quality outside the bounded lexical
window, end-to-end efficiency on natural long-running pursuits, and host policy
for unreadable or ambiguous evidence. Explicit incompleteness and safe data
availability do not guarantee that every model makes a correct final judgement.
These remain part of Namzu's broader autonomous-kernel vision.
