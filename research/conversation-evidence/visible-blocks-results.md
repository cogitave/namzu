# Visible tool blocks and evidence selection

Measured 2026-09-13. Baseline `612879e2`. This tests representation consistency
in bounded context selection, not a general memory or model benchmark.
[Driver](visible-blocks-cli.mjs) · [recorded results](visible-blocks-results.json).

## Finding

`createEvidenceRecallStep` used only string-valued history content when checking
whether an authenticated candidate was already visible. An identical passage
in a tool's text-block array was therefore classified as new text. With four
short matching observations already in those blocks, their archived copies
could consume all four new-passage slots ahead of a longer missing observation.
The archive search had found that observation; context selection withheld it.

The same omission applied to `prepared.context` and `prepared.system` from
earlier preparation stages. These fields already contribute to this request
and its remaining token estimate, but recall did not check their text.

The SDK now checks each tool text block independently, alongside string-valued
messages and earlier prepared context/system text. It never stringifies
binary data, document names or private reasoning, and never joins separate
blocks to manufacture a matching passage. The whole candidate batch is still
validated before visible candidates are moved into quoted source references.
Visibility is not authentication and does not make a past observation current.

The relevant primary comparison is Pydantic AI Harness at
`c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504`, whose
[`_user_prompt_text`](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py#L160)
extracts textual parts instead of binary representations. That function builds
a search corpus for a different message type. It is not evidence that Pydantic
implements Namzu's visibility allocation; the Namzu defect and its impact were
measured locally. Namzu additionally preserves block boundaries in its visibility
test rather than treating joined text as an already-visible quote.

## CLI comparison

Each trial creates an isolated workspace, Namzu home and conversation. The
durable scoped archive has five observations: four short receipts whose codes
were not recorded, then a longer original containing a fresh random receipt
UUID. The projected conversation already contains the first four observations,
either as plain tool strings (`--plain`) or independent text blocks. It contains
none of the original receipt code. Valid historical assistant/tool pairs are
persisted before the CLI is reopened in a separate process.

The actual built CLI runs `run --resume` with automatic evidence recall on,
web and project-memory recall off, and this ordinary question:

> What was the original ORCHID receipt code?

The observer records the actual request context and ordinary history. Scripted
controls replace inference only. The live runs forward the provider stream
unchanged: Codex `gpt-5.6-luna`, `low`, at most four iterations, 25,000 tokens
and a 90-second process timeout. Relevant built-module fingerprints must stay
unchanged during each run. All runs assert zero executed tools and unchanged
source transcript. Scripted answers test selection, not model comprehension.

| Trial | New passages selected | Original selected | Context characters | Accounted archive reads |
| --- | --- | --- | ---: | ---: |
| Baseline blocks, scripted | Four already-visible receipts | No | 2,008 | 34,672 bytes |
| Baseline strings, scripted | Original receipt | Yes | 2,589 | 34,672 bytes |
| SDK visibility fix, blocks, scripted | Original receipt | Yes | 2,589 | 34,672 bytes |
| SDK visibility fix, blocks, live Luna low | Original receipt | Yes | 2,589 | 34,672 bytes |

In the baseline block case, `omittedPassages: 1` and `additionalEvidence`
correctly exposed the missing observation's read address. It was not lost or
unavailable; a model could still recover it with an additional read. The fix
places that missing text into the automatic context, while three visible-source
references and one `omittedVisibleEvidence` share the unchanged four-passage
allowance. The same original text is now selected for both representations.

This fixture adds 581 context characters to deliver the missing text and its
source references; it is not a claim of token compression. Read work is unchanged.
The live model returned the exact random code in one request with no tool calls,
using 7,682 tokens. The budget ended at 17,318 tokens with no reservations,
in-flight requests or unsettled children. Subscription usage is unpriced in the
JSON; zero recorded dollar cost is not a free-inference claim.

Artifacts: `/tmp/namzu-visible-blocks-cli-tnB6Wa` (baseline blocks),
`/tmp/namzu-visible-blocks-cli-zh6xwc` (baseline strings),
`/tmp/namzu-visible-blocks-cli-xwAJXb` (fixed blocks),
`/tmp/namzu-visible-blocks-cli-Qdeixn` (intermediate live).

## Multiple archived runs

A CLI regression then placed the same five observations in five separately
closed runs. It still failed after the SDK visibility fix: CLI search returned
on each matching run, so the automatic retriever's finite page allowance ran
out before the original. The current run's capture also consumes a discovery
page in the process fixture. Only three earlier observations were inspected;
their visibility classification was correct, but the missing source was never
reached. `incomplete: true` honestly reported that limitation.

Automatic multi-term discovery now continues past exhausted matching runs
within its existing I/O, result and output caps. It still returns immediately
for an unfinished SDK source page. New explicit literal searches keep their
early return on a match. The fix accounts for JSON-serialized match bytes
across runs, including escaping; it does not expand the 12,000-byte match cap
or the 8 MiB automatic read allowance. The new regression stayed spread across
five runs instead of being simplified to a single run.

| Five-run trial | Original selected | Scan incomplete | Context characters | Accounted archive reads |
| --- | --- | --- | ---: | ---: |
| SDK visibility fix only, scripted | No | Yes | 2,066 | 20,506 bytes |
| Both fixes, scripted | Yes | No | 2,589 | 24,802 bytes |
| Both fixes, live Luna low | Yes | No | 2,589 | 24,802 bytes |

The final live process returned the exact random code in one request with no
tool calls, using 7,640 tokens and leaving 17,360 of its 25,000-token ceiling.
There were no outstanding reservations, requests or children. Both live trials
together used 15,322 tokens. Reaching the fifth source costs 4,296 additional
accounted read bytes in this fixture; this is a selection improvement, not a
latency or universal I/O reduction claim. Bounded discovery can still omit
later sources in larger conversations and must keep its continuation metadata.

Artifacts: `/tmp/namzu-visible-blocks-cli-hSxJDp` (before CLI packing),
`/tmp/namzu-visible-blocks-cli-d5sRnA` (final scripted),
`/tmp/namzu-visible-blocks-cli-gxRJhN` (final live). Reproduce the final shape
with `node research/conversation-evidence/visible-blocks-cli.mjs --split-runs`
and add `--live` for the bounded provider experiment. These fixtures seed
historical observations; they are actual CLI process tests, not an interactive
TUI keystroke test or evidence that live tools generated the seeded history.

SDK regressions compare string/block/prepared-system/prepared-context shapes,
unchanged input history, bounded output and full-batch ownership validation.
They also test split text, image/document fields and private reasoning that
must not falsely establish visibility. CLI regressions run the production
conversation retriever with both message shapes and verify an exact archived
read after releasing cached locations. A further regression pages through
eight runs containing heavily JSON-escaped text and checks complete,
nonduplicated retrieval within both byte ceilings.

Final workspace typecheck, build and tests passed: 6,542 SDK tests and 2,918 CLI
tests passed (five CLI tests skipped). The SDK's 264 process tests passed with
the same SDK production code. Lint, documentation conformance and compiled
fences, external-name and log-standard checks also passed. No release or
registry publication is implied by these checks.

## Remaining investigation

The same audit inspected Pydantic's
[`SnapshotHistorySource`](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_source.py),
which excludes derived summary messages using a prefix. Namzu's `recordShed`
retains a replaced summary alongside removed originals, and search can see
that text. Its impact on recall has not yet been measured. Distinguishing
kernel-generated summaries from ordinary messages containing similar prose
needs a separate provenance decision; this patch does not infer that distinction
from text or change summary retention.
