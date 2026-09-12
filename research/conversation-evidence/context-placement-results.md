# Request context placement and cache accounting

Measured 2026-09-12 on Linux/WSL, Node 24.19.0, continuing the
[retained-passage experiment](passage-results.md). Commands, request shapes,
usage, source fingerprints and artifact locations are preserved in
[context-placement-results.json](context-placement-results.json).

## Observed defect

The two preceding live runs recovered the requested identifiers, using 82,425
and 45,835 reported tokens. Their archived `request_envelope` records showed
unchanged tool schemas but system text changing at each request: the context
inventory grew as tools returned results. In the first run, system length went
from 10,651 to 11,362 characters; in the second, from 10,651 to 11,307.

The SDK appended that inventory as an ephemeral system message. Reading the
actual drivers showed that this portable position was misleading: Codex
collects system messages into `instructions`, and Anthropic collects them into
system blocks before history. Changing the inventory therefore changed text
ahead of the otherwise reusable conversation. This establishes a request
placement defect, not the cause of every observed cache miss.

Codex's native reasoning replay guard checks route, model, content and tool
calls; it does not compare the system text. The inventory was not shown to
discard native reasoning. That suspected failure is not a finding.

## Implemented contract

The SDK now accepts request-only `PrepareStepResult.context`: observations
with runtime provenance, projected after history without system authority or
replacement of the operator's last message. Stages can compose, replace or
clear it. Its size is included in later stages' remaining-context estimate;
each new step starts without the old contribution. It does not accumulate in
durable conversation history. The host still bounds its own contribution.

The CLI uses it for its existing bounded inventory. Actual CLI Session requests
were converted through both native provider drivers with only network transport
replaced by a recording fixture. Inventory text stayed at the end and out of
both system fields; earlier history remained intact.

Anthropic's message cache marker previously landed on the final message. With
ephemeral context there, it would include text the next request replaces. Its
driver now marks the last nonempty block before the first step context,
including a preceding tool-result block after pending results are flushed.
It does not mark that context or later messages. Requests without context keep
their previous behavior. This wire behavior passed provider and CLI tests;
no live Anthropic cache claim is made.

## Actual CLI observations

The [CLI harness](active-cli.mjs) retains its original protocol: read one
synthetic file, externally replace it before the next model request, recover
two unpredictable identifiers absent from the preview through conversation
search and exact read, and leave the replacement file intact. Its new request
observer records shapes and usage without altering live model decisions.

One offline check and one live Codex `gpt-5.6-luna`/low check were run; both
passed. The live run used one file read, one search and two exact conversation
reads, recovered both original identifiers and had no failed tools. The two
exact reads overlap; the first already spans both passages. Redundant reads
remain an observed issue rather than a claimed improvement.

| Live request | Prompt tokens | Completion tokens | Reported cached tokens | System characters |
| --- | ---: | ---: | ---: | ---: |
| Initial file read | 6,395 | 81 | 0 | 10,651 |
| Search retained text | 17,919 | 42 | 5,632 | 10,651 |
| Open exact text | 18,626 | 186 | 0 | 10,651 |
| Answer | 22,487 | 69 | 0 | 10,651 |

System digests were identical across all four requests within the live run.
The offline run also kept a constant system digest. Each post-read request had
exactly one inventory, and its previous inventory was absent from the retained
history. Diagnostic common-prefix lengths refer to portable message
serialization, not provider cache keys or token counts.

The live run reported **65,805 total tokens**, including **5,632 cached tokens**
on one request. This is higher than the earlier 45,835-token sample, with a
different call sequence. Neither a causal cache gain nor a token-cost reduction
is established. The eight-iteration/65,000-token admission budget was unchanged;
an admitted request may settle above that threshold. Subscription tokens have
no price mapping here, so the zero cost field does not mean the run was free.

## Reference inspected and remaining work

The pinned Pydantic AI Harness
[overflow implementation](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/tool_output_limits/_capability.py)
uses a bounded head/tail preview with a direct `read_tool_result` handle and
bounded subsequent reads. It was inspected as primary-source evidence for the
next output-cost investigation. This change does not copy its preview limits,
add automatic eviction or spend another model call on summarization.

The measured gap remains managing which already-read evidence stays active:
large repeated previews and overlapping retrieval results increase input cost.
A subsequent change must preserve exact recoverability, provenance and scope
while measuring task success and cost together. Correct placement alone does
not finish that work.

## Validation boundary

SDK request tests cover freshness, ordered composition, clearing, token
estimates and operator intent. CLI Session checks cover the real runtime and
both native wire conversions, alongside retained-text recovery after
compaction/restart, altered-artifact refusal and conversation scope. The full
workspace suite passed before the final Anthropic-only implementation; its
complete provider suite (207 passed, 40 skipped) and affected CLI suite
(11 passed) passed afterwards. SDK process regressions passed (254 tests).
Final workspace typecheck, build and lint passed, together with documentation
conformance/fences, exported-signature and test-presence checks, project-reference
and workflow-gate parity checks, and the external-name and log-standard gates.

Run-time source fingerprints are retained unchanged. Two subsequent SDK comment
corrections produced identical JavaScript with comments removed; final source
fingerprints are recorded separately. The Anthropic cache change is explicitly
covered by fixture-based wire tests, not the live Codex experiment. Release
coverage, evals, consumer installation and publishing are outside these results.
