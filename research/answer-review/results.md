# Reliable answer-review settlement

Date: 2026-09-12. This is a runtime correctness change, not a measured improvement
in general factual accuracy or a replacement for a task-specific verifier.

## Finding and decision

The ordinary prose `reviewAnswer` path caught any reviewer exception and returned
`accept: true`. A missing source or unavailable checking service could therefore
settle an unreviewed answer as if the callback had accepted it. The same path
awaited an uncooperative callback after cancellation and kept its consumed
correction allowance only in the orchestrator instance.

The runtime now separates three outcomes: explicit acceptance, valid rejection
with corrective feedback, and failed verification. Only a valid rejection
requests another model iteration. Callback errors and malformed verdicts fail
the run. A review dependency's throttle/context-overflow error is not attributed
to the generation provider and cannot trigger its recovery path. Cancellation
releases the wait, without claiming to terminate arbitrary callback work.

Rejection feedback and the consumed count are checkpointed together before the
next request, including exhaustion. A separate process restoring the same
checkpoint sees the remaining allowance even if feedback text was compacted.
Hosts must restore the review policy too; an older checkpoint, an emergency dump
without this field, or a changed policy is not a tamper-proof lifetime budget.

This exception behavior is a breaking SDK change, recorded as major. The CLI
inherits the SDK fix; its existing command gate still translates its own check
failures into bounded corrective feedback.

## Primary-source comparison

[Pydantic AI output validators](https://pydantic.dev/docs/ai/core-concepts/output/)
can request correction through `ModelRetry`. Its
[advanced tool documentation](https://pydantic.dev/docs/ai/tools-toolsets/tools-advanced/)
explicitly distinguishes that request from ordinary output-validator exceptions,
which abort the run unless an output-process error hook recovers. Namzu adopts
the separation of corrective feedback from checker failure; it does not copy
Pydantic's retry accounting or claim identical streaming behavior.

## Evidence

- SDK: 32 focused answer-review tests cover acceptance, bounded corrections,
  malformed verdicts/limits, checker exceptions, generation-error attribution,
  cancellation, restored allowances and invalid stored counters.
- CLI: the real `createAgentSession` + SDK + durable evidence writer/readers are
  exercised with scripted model decisions. A wrong receipt is rejected and then
  corrected; changed source ownership yields an error, no accepted completion
  and no extra model request. Existing retained-artifact integrity tests also run.
- Process: two consumers of the built SDK use `DiskCheckpointStore`. The first
  saves an exhausted review and removes feedback to simulate compaction. The
  second restores it with zero model calls and `answer_rejected`.

The opt-in [live script](live.mjs) first invokes the actual `run-stream --session`
CLI in an isolated workspace, then opens its persisted conversation through the
CLI Session engine with a host-supplied exact-copy reviewer. This tests the
production engine and provider; it is not a TUI rendering test. The reviewer is
specific to a known recorded receipt, not an automatic factual judge.

[Machine-readable results](results.json), original artifact directory
`/tmp/namzu-answer-review-RUXVso`:

| Operation | Model requests | Outcome | Measured tokens |
|---|---:|---|---:|
| Actual CLI reads `receipt.txt` and persists its observation | 2 | One successful `read`, correct receipt | 13,512 |
| CLI Session verifies its answer against that recorded source | 1 | Exact code accepted | 6,815 |
| Source ownership changes at verification time | 1 | Explicit review error; no `done`, pause or retry | 6,815 |

All requests used `gpt-5.6-luna`, low effort. Total: 27,142 tokens, all unpriced by
the driver; this is not a zero-cost claim. The source file stayed unchanged and
the built-code fingerprints stayed identical during measurement. The initial
script's seed-tool summary read the wrong presentation field and recorded null;
the result preserves it and separately records the retained transcript's sole
`read` execution. The script uses the correct field for future runs. No model
call was repeated to repair that reporting error.

## Limits and remaining work

Workspace validation passed: typecheck, all package builds, lint, all workspace
tests (SDK 6,429; CLI 2,873 passed and 5 skipped), all 258 SDK process tests, docs
conformance and fences. Signature exports, SDK test presence, log standards,
project references and workflow gate parity also passed. Lint retained the
existing 35 SDK and 14 CLI warnings.

This does not establish the cause of the earlier long-code copying error.
Containment of a quote, selection of the right source, semantic support and
answer completeness remain distinct checks. Forced finalization, terminal tools
and structured-output settlement have their own paths; this callback is not an
unbypassable boundary. Rejected or unreviewed text may already have streamed to
a host, which must distinguish provisional text from settled outcomes.

The wider dynamic-context and autonomous-kernel goal remains active. No push or
publish was performed; this report makes no claim that release-only coverage,
consumer-install, registry or publication gates have passed.
