# Run-owned inference during answer review

Recorded 2026-09-13 on base `6e14db97`.
[Machine-readable control and live receipts](review-inference-results.json).

## Gap and implementation

The retained-evidence work exposed the candidate's request context to host
reviewers. A reviewer that also wanted model inference still had to construct an
external client or another run and arrange accounting itself. Preparation had a
bounded, run-owned capability; review did not have the same capability.

`AnswerReviewContext.generateText` now supplies one tool-free inference per
prose or structured review invocation. It reuses preparation's transport,
request/result shapes, limits, run cancellation, provider chain and token ledger.
The selected step model and run effort apply. Only explicit strings are sent;
no candidate, source, tools, history or native response schema is automatically
attached. The result contains bounded visible text, usage and serving provenance.
Its capability is revoked when the callback returns, throws or is cancelled.

This is infrastructure for an optional host policy, not an automatic factual
judge. The host must await the call and validate its output. An invalid verdict
or failed inference does not become acceptance. A valid rejection still uses
the existing bounded correction and checkpoint path. Auxiliary usage does not
replace the candidate's main-step usage or provenance, including when review
causes the provider chain to fall back.

## Primary-source comparison

[Pydantic AI's delegation guide](https://pydantic.dev/docs/ai/guides/multi-agent-applications/#agent-delegation)
describes passing the parent's usage object into an awaited nested agent run
so accounting includes both. Namzu instead reuses the active run's metered
provider chain for a single bounded request; it does not create a delegate agent
or transfer the full conversation. This comparison concerns shared accounting,
not an identical API or cancellation implementation.

[Zheng et al.](https://arxiv.org/abs/2306.05685v4) examine model judges and their
position, verbosity and self-enhancement biases and reasoning limitations.
Their findings motivate keeping model judgments separate from independently
checkable evidence. This local experiment neither reproduces their benchmarks
nor establishes that a low-effort model is a reliable general judge. For literal
identifier equality, the earlier deterministic reviewer is simpler and cheaper.

## CLI protocol

```sh
node research/conversation-evidence/review-request-cli.mjs --judge
node research/conversation-evidence/review-request-cli.mjs --judge --live
```

The driver extends the [previous request-review experiment](review-request-results.md).
A separate production CLI seed process runs a real file read and retains a
350-line manifest. Its visible preview and summary omit the random receipt.
The parent replaces the file, then a fresh process loads that conversation using
the built CLI Session host. Automatic recall supplies the historical receipt in
request-only context. The reviewer selects the reference from that context and
revalidates its scope and quote through `readConversationEvidence` before asking
for a judgment. The existing page can be partial so long as it contains the
entire authenticated bounded quote; preview-only data is refused.

The first candidate is deliberately corrupted (`RECEIPT` to `RECEİPT`) by the
probe. It is not a naturally observed model mistake in this trial. In the live
arm, the model evaluates that candidate, produces the subsequent correction and
evaluates the correction. Those three live streams are forwarded unchanged.
Both verdict requests carry only a fixed literal-extraction task, the validated
source quote and the candidate. Their binary JSON result is checked for shape.
The deterministic comparison is recorded as an oracle but does **not** determine
the runtime verdict in judge mode. The parent independently checks the settled
answer against its seed receipt. The scripted control substitutes inference
only; archive and runtime operations remain production code.

The run has a 25,000-token admission allowance, three loop iterations, one
correction opportunity, 90-second cancellation and a 120-second process timeout.
Each reviewer asks for at most 128 output tokens and inherits the capability's
ten-second deadline. This is admission accounting, not a hard billing ceiling.
The seed separately has three iterations, a 25,000-token allowance and 30 seconds,
with zero model spend. Both arms retain matching before/after built-module
hashes and leave the externally replaced file unchanged. No user transcript or
credential is included in the checked-in data.

This is an embedded CLI Session test; it does not add a CLI `--judge` option or
test TUI presentation. The flag belongs only to this research driver.

## Measured results

| Arm | First judgment | Second judgment | Settled answer | Live model tokens |
| --- | --- | --- | --- | ---: |
| Scripted, `3o8O00` | Reject | Accept | Exact receipt | 0 |
| Live Luna/low, `yJcNnN` | Reject | Accept | Exact receipt | 8,780 |

The live accounting is 278 tokens for the first judgment, 8,253 for correction,
and 249 for the second judgment. Both judgments together cost 527 tokens.
The owning run reports 8,780 own/tree tokens and zero unresolved requests, with
16,220 of its allowance remaining. Both judgments identify the actual
`codex/gpt-5.6-luna` route at chain index zero and match the independent oracle.
No request-only recall block is implicitly attached to the two auxiliary
requests: their evidence is the explicit short quote chosen by the reviewer.

SDK regressions exercise prose, tool-mode and native structured review;
selected-model inheritance; correction-scoped capability lifetime; input
isolation; combined usage; exhausted-budget admission; invalid tool-bearing
output; review failure; fallback provenance; and cancellation with unresolved
receipts. Existing preparation, review/retry and request-snapshot tests remain
in force. A model-backed reviewer and a deterministic one can use the same
source access and correction machinery, but do not have the same reliability.

Workspace type checking, lint and build passed, along with all workspace unit
tests (SDK: 6,596; CLI: 2,931 passed and five skipped) and 264 SDK process tests.
Docs conformance/fences, signature exports, project references, SDK test presence
and publish metadata also passed. This is local validation, not a release or a
claim that every publishing gate ran.

## Remaining boundary

The [copy/transform controls](copy-intent-results.md) show why an exact-copy
policy cannot simply be enabled for every conversation. This new capability
makes an optional model policy accountable and cancellable; it does not derive
the correct task contract or guarantee its judgments. There is one live
correction trial here, not a measured general accuracy improvement. Source
authentication, semantic intent, current-state verification and complete task
fulfilment remain separate responsibilities.
