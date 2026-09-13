# Derived summaries in conversation evidence

Measured 2026-09-13. Baseline `4801a6f4`.
[Driver](summary-evidence-cli.mjs) · [recorded results](summary-evidence-results.json).

## Source audit and reproduced defect

An actual second structured compaction pass replaces its previous unretained
summary. `recordShed` correctly archives that removed message before replacing
the live array. Previously, the retained text was classified as ordinary
`compaction_shed:system`, with no machine-readable distinction between the
kernel's derived summary and a source message. Automatic evidence recall then
ranked both together. Four short matching summaries could occupy its four
passage slots ahead of a longer original that discovery had already found.

The primary comparison was Pydantic AI Harness at pinned commit
`c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504`.
Its [`SnapshotHistorySource`](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_source.py#L115)
omits summary artifacts when reconciling persisted snapshots. It uses the exact
summary prefix because its system-prompt part has no metadata field. That is a
different storage contract: Namzu deliberately retains what a compaction removed
and keeps exact reads of it available. Namzu now marks its generated system
summaries explicitly instead of applying a prose-prefix exclusion to the archive.

## Implemented behavior

`SystemMessage.source` can be `{ type: 'compaction-summary' }`. Both automatic
and host-requested compaction generate this metadata. Text extraction preserves
it as `compaction_shed:summary` across inline/large archives, live captures,
closed sources and snapshots. Unmarked system text with the same heading is
unchanged. Non-system roles and source arrays do not acquire summary identity.
Older unmarked records are not retroactively classified.

Automatic recall ranks other matching source records first, then known derived
summaries, with separate BM25 statistics. A summary can fill remaining slots or
be the only matching evidence. It still has an exact read address if its text is
omitted. All candidates pass the same scope and metadata validation before
selection. This ordering is a retrieval heuristic, not an assertion that every
non-summary record is accurate or more relevant to every possible question.

The change preserves whole-message restoration, text bytes and part ordinals.
Index caches are rebuilt for the new metadata without changing the source seal
used by exact addresses. Source-marker tampering invalidates a previously
issued address. It grants no filesystem or conversation authority.

## CLI experiment

Each isolated workspace and Namzu home receives one scoped closed archive:
four different summary messages produced by the actual SDK summary factory,
followed by one original tool observation with a random receipt UUID. The
projected conversation contains none of that UUID. The process reopens the
conversation through the actual built CLI `run --resume` and asks:

> What was the original ORCHID receipt code?

Automatic recall is on; web and project-memory recall are off. Scripted
inference reports whether the original was present in the actual request;
it does not inject the random code independently. The live run passes the
provider stream through unchanged, using `codex/gpt-5.6-luna`, low effort,
at most four iterations, a 25,000-token ceiling and 90-second process timeout.
Every trial checks unchanged source transcripts, zero executed tools and
stable relevant built-module fingerprints.

| Trial | Selected new passages | Original selected | Context characters | Accounted archive reads |
| --- | --- | --- | ---: | ---: |
| Baseline scripted | Four unmarked summaries | No | 2,272 | 34,190 bytes |
| Fixed scripted | Original, then three marked summaries | Yes | 2,700 | 34,753 bytes |
| Fixed live Luna low | Original, then three marked summaries | Yes | 2,700 | 34,753 bytes |

All three scans reported complete traversal of this fixture. Each omitted one
passage and retained its address: the baseline omitted the original, while the
fix omitted the fourth summary. The new provenance and guidance add bytes;
this is improved source selection, not a token-compression claim.

The live model returned the exact random receipt code in one request, without
tool calls, using 7,591 tokens. Its budget ended with 17,409 remaining tokens,
zero reservations and no in-flight requests or unsettled children. Reported
subscription usage is unpriced; a zero recorded dollar cost is not evidence
of free inference. No baseline live-model failure is claimed: the deterministic
baseline establishes context selection, not how a model might recover via tools.

Artifacts: `/tmp/namzu-summary-evidence-cli-5X0uu2` (baseline),
`/tmp/namzu-summary-evidence-cli-Z0op6w` (fixed scripted),
`/tmp/namzu-summary-evidence-cli-h0xwqQ` (fixed live).
Reproduce with `node research/conversation-evidence/summary-evidence-cli.mjs`;
add `--live` for the bounded provider trial. The driver seeds retired summaries
through the real factory; it does not claim these particular summaries were
produced by four live model compactions. A separate SDK regression exercises
two actual structured compaction passes and verifies that the first summary
is archived with its marker. This is a CLI process test, not TUI interaction.

## Limits and regression coverage

The candidate pool, page count, context allowance and I/O ceilings are unchanged.
Enough summaries can still occupy bounded discovery pages before an original
is reached; this change ranks the candidates that actually arrived. The host
continues to expose incomplete traversal and continuation metadata. Queries
about the summaries themselves may benefit from explicit archive reads.

SDK regressions cover source ordering, summary-only fallback, omitted addresses,
scope rejection, both manual compaction paths, a second automatic pass,
inline/large archives in all three consistency modes, ordinary lookalike text,
non-system/malformed markers, restoration and changed-source refusal. A CLI
regression verifies the production retriever prefers original tool text while
all four derived summary records remain exactly readable after cache release.

Validation: workspace typecheck and build passed. The workspace test run passed
6,548 SDK tests and all other package suites except one existing CLI goal-view
wait. That test file then passed alone (12 tests); a complete CLI rerun passed
2,919 tests, with five skipped, without changing that test. The initial timeout
is recorded as unresolved intermittent test behavior, not erased by the rerun.
All 264 SDK process tests passed. Lint, docs conformance and compiled fences,
workflow parity, project references, test presence, external-name and log
audits, and exported signature checks passed. These local checks do not imply
a release or publication.
