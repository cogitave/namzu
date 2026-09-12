# Smaller previews with exact retained evidence

Measured 2026-09-12 on Linux/WSL, Node 24.19.0. This follows the
[request placement correction](context-placement-results.md), whose remaining
input cost included large previews and overlapping retrieval. The raw summary,
source fingerprints, request usage and artifact paths are in
[preview-results.json](preview-results.json).

## Source and engineering decision

Namzu used one 40,000-character threshold both to trigger tool-output spilling
and to size the resulting preview. A 308,383-character observation retained on
disk still carried a 40,000-character preview into each later model request.
This was measurable input cost even with stable system instructions.

The pinned Pydantic AI Harness separates the size band from
[`Spill.preview_chars`](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/tool_output_limits/_bands.py),
with explicit fallbacks, and builds a
[head/tail preview with a read handle](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/tool_output_limits/_capability.py).
The transferable decision is to separate retention from the cost of carrying
its preview. Its 1,000-character default is not evidence of an optimum for
Namzu's tasks.

Namzu's SDK now optionally uses `retainedToolPreviewChars` after the full host
output and its integrity manifest have been saved. An absent/zero value keeps
the prior behavior. The original spill threshold remains in force, so smaller
ordinary outputs are untouched. Failed storage or integrity-manifest creation
keeps the ordinary preview budget, as does a preview too small for the recovery
pointer. The text cap still includes notices and preserves Unicode boundaries.

Recorded CLI turns choose 4,000 characters by default. Operators can set
`compaction.retainedToolPreviewChars: 0` to retain the previous preview size.
This is an explicit CLI default change, declared as major in its changeset.
The SDK's optional field is minor. The setting reaches ordinary turns, resumed
runs and nested receipts. Stateless sessions and delegated workers retain their
existing defaults. Existing history is not rewritten.

Independent model text keeps its separate ordinary budget: its bytes are not
replaced with the host preview. Shared host/model text reuses the short preview,
with rich blocks retained subject to their independent cap. This avoids claiming
that the host transcript is an exact archive of a distinct model-only channel.

## CLI protocol and observations

The [existing executable CLI check](active-cli.mjs) keeps its original outcome
assertions. A synthetic file contains two unpredictable identifiers outside
the preview. It is read once and then replaced externally before the next
model request. The model must recover the original identifiers using
`search_conversation` and `read_conversation`, with no repeated workspace read,
command or external action. Both identifiers, exact read use, no failed tools
and the unchanged replacement file are checked.

The harness gained a config-only `--preview-chars=0` option and records actual
preview lengths. Live decisions remain provider-generated. One live run per
condition was declared before execution, both using Codex `gpt-5.6-luna` at
low effort with the same eight-iteration/65,000-token admission limits.

| Run | Actual preview chars | Tool sequence | Total portable input chars across requests | Reported total tokens | Outcome |
| --- | ---: | --- | ---: | ---: | --- |
| Scripted, previous preview | 40,000 | read → search → exact read | 135,469 | 0 | Passed |
| Scripted, new default | 4,000 | read → search → exact read | 25,044 | 0 | Passed |
| Live, previous preview | 40,000 | read → two searches → exact read | 139,899 | 64,486 | Passed |
| Live, new default | 4,000 | read → search → exact read | 26,428 | 32,779 | Passed |

All four runs used one workspace read and recovered both original identifiers;
none failed a tool or changed the externally replaced file. The original
308,383-character tool output stayed fully retained.

With the same scripted decisions, total portable input text fell by about 81.5%.
Those lengths describe the observer's UTF-16 serialization of conversation
messages, excluding system instructions and tool schemas; they are not billed
tokens. In the two live samples, reported total tokens fell by about 49.2%.
The earlier-preview run used an extra literal search; the candidate also chose
a slightly earlier valid byte offset for its exact read. Live choices therefore
differ, and this pair does not isolate preview size from every behavioral effect
or establish a general success rate or cost improvement.

The reference live run reported 16,896 cached tokens; the candidate reported
5,632. Per-request counts remain in the JSON record. Subscription usage is unpriced here;
the zero monetary cost field must not be read as free execution. No timing or
native-Windows claim is made, and no live non-Codex provider was exercised.

## Contract validation and limits

Tests cover the separate threshold, exact retained bytes, Unicode boundaries,
missing storage and failed manifests, recovery pointers that cannot fit,
disabled/nonrestrictive settings, direct and real-worker nested execution,
rich blocks and independently supplied model text. The ReactiveAgent test uses
its actual query loop. The CLI Session test checks the new default, explicit
zero and an explicit positive value, then retrieves original text after the
workspace file changes. Existing compaction/restart, tamper and scope tests
remain passing.

Workspace typecheck, lint, build and tests passed (SDK 6,299; CLI 2,830 with
five skips), along with 255 SDK process regressions, documentation checks,
exported signatures, project references, test presence and workflow-gate parity.
Release coverage, evals, consumer install and publishing are not claimed.

This reduces new retained-preview cost; it does not decide what the model has
understood, remove old results or prevent redundant reads. Some tasks can need
more retrieval calls when their relevant text falls outside the shorter preview.
Broader task measurements are still needed, particularly natural discovery
without the protocol's explicit recovery instructions and sessions with many
unrelated retained outputs.
