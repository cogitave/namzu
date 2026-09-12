# Resident evidence recall — 2026-09-12

At `f1e33a1f`, the CLI created an isolated session for each resident step and
supplied its latest summary, approved learning and pending wake inputs. Consumed
wake inputs and older summaries remained in immutable agenda revisions, but no
model-facing tool could retrieve them. The existing CLI conversation search
binds one Session; it does not cross these fresh resident Sessions. This is a
reachability gap even when the storage itself has retained the evidence.

## Source inspection and design

The inspected Pydantic AI Harness checkout is pinned to
[`c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504`](https://github.com/pydantic/pydantic-ai-harness/tree/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504).
Its [`HistorySource` and `SnapshotHistorySource`](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_source.py)
separate durable history from the search capability. The snapshot adapter
preserves repeated identical messages at different sequence positions, recovers
originals from preceding snapshots and excludes derived compaction artifacts.
Its [`ConversationSearch`](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_capability.py)
uses BM25 and defaults to an explicitly bound conversation scope. This is source
inspection of that revision, not a claim about the newest published package or
a runtime performance comparison.

Namzu adopts the separation between source, retrieval tools and prompt guidance.
This iteration uses existing immutable agenda records rather than reconstructing
complete conversations. Adjacent revisions identify a settled claim; the source
returns its summary and consumed wake inputs, without treating the summary as
independent verification. Equal content in different settled steps remains at
different addresses. The source is bound to one pursuit and the admission's
upper revision; a model cannot request another tenant, pursuit or filesystem path.

Search is literal and newest first. Per-page revision and byte limits bound disk
work independently of output limits; empty pages may still have continuation.
Only two parsed snapshots are cached. Unlike a full corpus snapshot search, this
does not need to load the whole history before answering a page. It is still a
linear scan, and it does not provide the semantic ranking or raw-message recall
of the inspected Pydantic capability. No superiority claim is established here.

The [SDK contract](../../docs/sdk/resident-recall.md) documents limits, exact-text
pagination, corruption behavior, scope ownership and the trusted filesystem
boundary. The CLI mounts the tools in both resident context profiles, including
deferred loading, and validates the executing run's Session/Project/tenant. A
completed or unrelated run cannot reuse the source through these tool callbacks.

## CLI experiment

The [reproducer](history-recall-cli.mjs) creates an isolated temporary home and
workspace. Each add, seed, status, wake and run uses a separate process. The seed
process uses real SDK claim/settlement operations to establish two **scripted**
past steps: an original tracking code/address, then a corrected address with the
same tracking code. The latest state contains neither exact value. Distinct
random UUIDs prevent guessing from the task. The matching excerpts deliberately
end before those identifiers, so exact reads are required.

These seeded steps do not measure model learning or natural compaction. The
live model receives a new recipient confirmation and must retrieve the recorded
details. Only this final admission calls a provider. Default mode performs local
control and retrieval assertions with no model call.

```bash
pnpm -r build
node research/resident/history-recall-cli.mjs
node research/resident/history-recall-cli.mjs --live
node research/resident/history-recall-cli.mjs --live --interactive
```

Both live runs used Zen `muse-spark-1.3-contributor-free`, low effort, read-only
plan permissions and deferred schema loading, bounded to one admission, six
iterations and 40,000 reported tokens. The isolated fixture disables web search
and filesystem sandboxing; the test asserts that no filesystem, shell or effect
tools were called. Tool dispatch and completion are read from actual
`transcript.jsonl` records, not inferred from the final answer.

| Context profile | Actual tool calls | Reported total tokens | Result |
| --- | --- | ---: | --- |
| Resident | One search, two exact reads | 24,847 | Exact original tracking code and corrected destination |
| Interactive | Two searches, four exact reads | 37,755 | Exact original tracking code and corrected destination |

The interactive run first browsed summaries, read the correction, then searched
for DELTA to read the original input. It read two summary parts in addition to
the two wake inputs. This was extra retrieval work, not an effect replay or a
retry of a failed test. Both invocations settled `complete`, confirmed resource
cleanup, and admitted no further step when reopened. There were two live
admissions and no semantic retries. Usage was unpriced, so a reported zero cost
is not a measured monetary cost or saving.

[Recorded results](results/2026-09-12-history-recall.json) include tool inputs,
completion status, usage and source/build fingerprints. Raw local fixture
transcripts remain at the recorded temporary paths; the committed result omits
provider reasoning and unrelated local data. These two synthetic examples do
not establish general memory quality or a performance advantage.

## Other verification and remaining scope

SDK tests exercise large histories, empty pages, byte caps, invalid/symlinked
records, exact Unicode pages, duplicate content, archived pursuits and frozen
admission boundaries. The real-process interruption regression kills an owner
after a file effect: recall reports no completed step until explicit inspected
settlement, then reads the consumed inputs without replaying that effect.
Prompt tests preserve the history reference and guidance through compaction.
CLI session tests execute the actual registered tools with a scripted provider,
reject unrelated/departed runs and keep ordinary chats free of these tools.

Local verification passed: workspace typecheck, build, lint and package tests
(SDK 6,247 passed; CLI 2,819 passed and five skipped), the three selected resident
agenda/archive process tests, documentation conformance and compiled fences,
exported signature types, SDK test presence and project-reference checks. Lint
retains existing warnings. This is not a claim that every release gate ran.

The live experiment used foreground CLI processes on Linux. It did not exercise
a TUI, native Windows, a managed worker or a model-induced compaction. Both
foreground and managed construction paths pass the source; those are separate
claims from the two live runs above.

Full historical tool-result retrieval, a durable search index with bounded total
scan cost, freshness validation against external state and evaluations over long
natural tasks remain future work. The wider resident-agent vision is unfinished.
