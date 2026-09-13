# Record origin, source diversity and unsupported claims

Recorded 2026-09-13 against `52f2d092` and the accompanying SDK change.
[Reproducible CLI probe](record-origin-cli.mjs) ·
[Observation record](record-origin-results.json).

## Why this change

The archive retains source tags, but automatic recall called all returned text
historical observations. That includes `message_completed` and compacted
assistant messages. The existing bounded BM25 ranking could also spend all four
passage slots on distinct versions of a model claim, omitting an already matched
tool record. Exact-string deduplication does not fix differently worded claims.

Letta Code's [published continuity prompt](https://github.com/letta-ai/letta-code/blob/main/src/agent/prompts/letta.md)
explicitly treats past assistant messages as the agent's own statements, which
can include mistakes. This supports separating what was said from what was
observed; its broader identity and cross-conversation policy is not adopted here.
[Self-RAG](https://arxiv.org/abs/2310.11511) distinguishes retrieval and critique
through trained reflection tokens. Namzu does not implement that trained model
or claim its benchmark: source metadata is not a learned support evaluator.

[Diversity-based retrieval](https://www.cs.cmu.edu/afs/cs/Web/People/jgc/publication/MMR_DiversityBased_Reranking_SIGIR_1998.pdf)
is another design reference. MMR combines relevance and novelty. This change
uses a simpler bounded producer-kind coverage pass, not semantic similarity,
MMR's objective or a claim that distinct producers independently corroborate
anything. The local failure determines the concrete change.

## Mechanics and controlled selection

All candidates still pass the original scope, integrity and size validation.
Non-summary positive BM25 matches retain their best match first, then the best
available match from each other producer kind, then remaining scored matches.
Unknown host labels share one kind. Known summaries remain last with separate
statistics. The pass is linear in the already bounded sorted pool (at most 24
candidates), with no additional I/O, model call or page allowance. If there is
only one slot and the highest-scoring passage fits, that match remains the
selection. Slots and character limits can still omit a producer kind.

The `recordKind` field is derived from authenticated source tags, not excerpt
text. Selected passages and visible-source references retain original bytes,
addresses, status and timestamps. When assistant records are eligible, bounded
context guidance asks the model to attribute unsupported statements as claims.
Explicit archive tools are unchanged. This is guidance, not an answer verifier.

The deterministic conflict fixture contains four differently worded assistant
claims and one original tool record. Before the change, all four selected
passages were assistant messages; afterwards the tool record took the second
slot. Exactly four passages are still selected and the omitted claim retains
its read address. Both scans accounted for 47,220 bytes. The emitted context
grew from 2,300 to 2,964 characters, including the longer original passage and
producer guidance. This establishes selection behavior, not answer quality.

## Live CLI observations

Seeds are controlled records in a real scoped `RunDiskStore`, representing
compacted conversation history. The seed's tool event is synthetic; this probe
does not claim the earlier file was read by a live model. The follow-up uses
actual CLI Session creation, process reopen, Codex transport and Luna low.
The current workspace file contains no historical code. The request uses plan
permissions, three iterations, 20,000-token admission and a 120-second process
deadline. Query resolution is disabled to isolate record selection/attribution;
other memory and web search are disabled. No fingerprinted code changed during
any sample.

| Case | Result | Calls / live tokens |
| --- | --- | --- |
| Before: only assistant claim | Asserted the claimed code as the original file value, with no supporting observation | 0 tools; 7,196 tokens |
| After: only assistant claim | Searched twice and read the assistant record, then exhausted admission before a final answer | 3 tools; 22,973 tokens |
| After: what did you say? | Recovered the claimed code but said “You told me”; speaker attribution was wrong | 0 tools; 7,225 tokens |
| After: conflicting tool and assistant records | Returned the original tool code rather than the repeated assistant code | 0 tools; 7,685 tokens |

Total live usage: **45,079 tokens**. Admission is not a hard billing ceiling: an
admitted request can finish beyond remaining allowance. The unsuccessful case
is retained as unsuccessful; the budget was not increased to obtain a passing
answer. The initial probe script only collected completion artifacts on a zero
exit. It was corrected to also retain nonzero-run evidence; the failed sample's
three native request traces and recorded `token_budget` stop remain available.

Only the claim-only case has a before/after live pair. These few controlled
samples cannot establish a general accuracy or cost improvement. The conflict
sample supports the value of preserving the tool record, while the other two
post-change cases show that labels alone do not solve attribution or excessive
verification. The explicit “what did you say?” control is not counted as a full
pass merely because the identifier matched.

## Terminal and tests

The conflict conversation was also reopened in an actual 80-column TUI with an
[offline assertion transport](record-origin-tui-fixture.mjs). It checks that
assistant claims and tool results reach the prepared request with distinct
producer tags and claim guidance. It accepted input, returned to an idle
composer and exited through `/exit` with code zero. This checks interactive
wiring, not live model reasoning, and consumes no vendor tokens.

Focused SDK tests cover source diversity, unknown-label grouping, visible claim
references, exact source bytes, zero-score kinds, one-slot behavior and existing
scope/preview/cancellation/character-bound guarantees. Existing CLI archive
checks cover reopen, exact reads and integrity controls. Validation totals and
local trace paths are recorded with the observation JSON.

Workspace typecheck and lint passed (existing lint warnings remain). All package
tests passed after updating one CLI assertion for the corrected historical-record
label: 6,654 SDK tests, 2,945 CLI tests (five skipped), and 123 OpenAI driver tests.
The initial full run exposed that stale assertion; the final full CLI suite
passed. Build, docs conformance/fences, signature exports, SDK test presence and
publish metadata also passed. No push, publication or full release-gate run is
claimed.

## Remaining work

The runtime must still distinguish successful answer delivery from merely
withholding an unsupported claim. The next behavioral controls should target
speaker attribution and bounded completion after exhaustive-enough archive
inspection. A model claim can be correct, and a tool can echo an unsupported
claim: producer labels alone cannot certify fact support or source independence.
The selection pass also cannot recover an original which never entered its
bounded candidate pool. Aliases, cross-paragraph evidence and longer history
remain necessary evaluation dimensions.
