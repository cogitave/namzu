# Ordinary conversation evidence milestone audit

2026-09-13, implementation `7579aa0c`. The finite milestone is to make retained
SDK tool evidence reachable in ordinary CLI conversations after compaction and
restart, with scope, integrity, cancellation and bounded retrieval intact.
The broader autonomous-kernel vision remains unfinished.

The audit re-read current composition and assertions, reran process probes and
37 real CLI Session tests, and checked earlier live/TUI artifacts against the
current build. [Recorded audit results](milestone-audit.json) separate new
zero-inference checks from earlier live model usage. No new live model call,
production change, package version change, push or publication was made here.

| Requirement | Evidence checked | Result and limit |
| --- | --- | --- |
| Inspect a primary implementation | Local Pydantic AI Harness `c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504`, `conversation_search/_toolset.py`, especially `search_conversation_history` | It rejects missing conversation scope, ranks untruncated text, then constructs display windows. Namzu reuses source/display separation and explicit scope; its bounded index and automatic context mechanism are its own implementation. |
| Reuse SDK evidence in ordinary conversations | CLI `tui/agent.ts` mounts search/read through the invoking run's scope and caches preparation per Session. `run` resume, persistent `run-stream`, TUI and `drain` supply the host-owned conversation boundary. | Stateless hosts receive no conversation tool promise. Recorded conversations enable automatic recall unless explicitly disabled. |
| Preserve exact text and older history | `conversation-search-reaches-session.test.ts` reconstructs retained `read` and `bash` text across all Unicode pages; checks compacted original messages, rich text, source classification and summary references | The 37-test file passed on the current build. Recoverable text stays distinct from previews and derived summaries. No binary or opaque-reasoning retrieval claim. |
| Restart with a replaced workspace file | `cli.mjs` seeds a real read, closes the Session, removes original IDs from the visible projection and replaces the source file; a new CLI process searches and reads the original | Both original IDs recovered; only the two archive tools ran during recovery. This fixture replaces the projection deliberately; actual compaction is covered separately. |
| Actual compaction and small-model recovery | The latest [failed-planner comparison](query-fallback-results.md) runs 18 intervening CLI turns and `Session.compact`, then reopens for Luna/low inference | 76 messages become 9; 67 are archived and both original IDs leave the projection. Candidate historical and current-state answers were correct. The audit rechecked all 16 measured production hashes and both original artifact hashes without another model request. Single samples do not establish general accuracy or savings. |
| No replay to recover evidence | Updated `checkpoint-evidence-cli.mjs` kills the seed after a recorded shell effect, while a subsequent read is interrupted; another process enters through `drain` | Fresh positive, altered-artifact and provider-failure probes all keep the effect counter at 1. The positive case retrieves the original receipt. This does not promise exactly-once arbitrary external effects. |
| Altered artifacts and foreign ownership | Real Session tests mutate retained bytes and run ownership, reject a cursor bound to another address and reject another Session's access. The fresh altered checkpoint probe reports unavailable evidence. | No replacement bytes become a valid original. Earlier [source-boundary probes](source-boundary-results.md) additionally exercise invalid custom source pages. A trusted host's self-consistent arbitrary text is not authenticated just by matching scope fields. |
| Cancellation and invocation lifetime | Two fresh `capture-cancellation-cli.mjs` processes exercise cooperative and delayed uncooperative storage. Session tests close/change the owning invocation. | First search times out, following search succeeds, and the original file is read once. An uncooperative store retains serialization until it settles; cancellation does not forcibly terminate arbitrary host code. |
| Real TUI observation | Latest controlled resume runs in a 100×28 PTY with deliberate planner failure; captured terminal is replayed through xterm | Both recovered IDs appear once, composer returns idle, and `/exit` is zero. The audit rechecked the saved screen hash. This controlled rendering test is separate from live inference and does not exercise typing `/compact`. |
| Public contract and coherent delivery | SDK evidence/recall docs, CLI conversation-evidence/context pages, docs log, changesets and local implementation commits | Public behavior and opt-outs are documented. This audit changes only research artifacts. The implementation's workspace typecheck/build/lint/tests, docs/fences, test-presence and signature-export checks passed; complete release gates and publication are not claimed. |

## An obsolete test assumption found by rerunning

The first fresh checkpoint probe failed before producing `request.json`. Its
wrapper asserted that **every** provider request must offer conversation tools.
Query planning is now enabled and correctly has no tools, so the wrapper itself
threw. Without a usage receipt the finite budget correctly refused further
admission; the missing request file was a consequence, not an archive defect.

The research wrapper now recognizes the specific preparation request separately.
Its deterministic variant returns a valid `none` plan with a zero-usage mock
receipt, leaving the actual explicit search/read path under test. Live mode
continues to use the real provider for planning. Tool availability is asserted
on main requests, and preparation remains tool-free. All three checkpoint
variants passed afterward. The original failed probe is retained in the audit
record; no budget bypass or production exception was introduced to make it pass.

## Completed boundary and next work

The ordinary-conversation milestone has concrete implementation and execution
evidence for every required path. It does not establish perfect reference
resolution, complete semantic recall, a general benchmark advantage or a fully
realized autonomous agent.

A separate gap is visible in `integrations/resident/session-step.ts`: each
resident admission creates a fresh Session and mounts explicit
`search_resident_tools`/`read_resident_tool` sources, but passes no ordinary
`conversationSessions`. The conversation preparation hook therefore cannot
automatically select original tool evidence from earlier resident admissions.
The existing explicit recovery remains available and tested.

The next bounded milestone is to evaluate and add resident preparation over its
already-authorized settled-pursuit source, reusing SDK selection and context
budgets. It must preserve the captured agenda revision, exclude other pursuits
and unresolved claims, retain explicit tools, validate cancellation and source
integrity, and measure actual resident execution before claiming improvement.
It should not broaden ordinary-chat access or create a second history store.
