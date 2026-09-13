# Task-conditioned review and operator input retention

Recorded 2026-09-13 on base `61aab1fb`.
[Machine-readable observations](task-review-results.json).

## Question and primary-source comparison

The preceding [review-inference probe](review-inference-results.md) used a fixed
literal-copy task. The [copy/transform controls](copy-intent-results.md) showed
why that policy cannot judge every user request. This experiment gives the
reviewer the actual current request and pairs correct and incorrect candidates
for the same operation. It separately permits an `unverifiable` classification
when historical evidence cannot establish the requested current fact.

[ALCE](https://arxiv.org/abs/2305.14627v2) evaluates answer correctness and
citation quality separately; locating a source is not the same measurement as
answering correctly. [Pydantic AI output validation](https://pydantic.dev/docs/ai/core-concepts/output/#output-validators)
separates explicit retry feedback from validator exceptions. Its
[TrajectoryJudge documentation](https://pydantic.dev/docs/ai/harness/trajectory-judge/)
and [inspected implementation](https://github.com/pydantic/pydantic-ai-harness/blob/main/pydantic_ai_harness/trajectory_judge/_capability.py)
describe a different intervention: bounded, periodic background evaluation,
attributed steering and shared accounting. An in-flight evaluation is cancelled
at run end; the implementation refuses judged work inside durable workflows
whose replay would repeat those calls. These sources were inspected on the date
above; the `main` code link is mutable.

Namzu's experiment uses an awaited answer-review callback and one metered
request. It does not reproduce ALCE, run Pydantic's judge, add a background
supervisor, or claim equivalent durable-execution behavior. A bounded callback
and a well-formed verdict do not establish semantic correctness on their own.

## CLI protocol

```sh
node research/conversation-evidence/task-review-cli.mjs
node research/conversation-evidence/task-review-cli.mjs --steering
node research/conversation-evidence/task-review-cli.mjs --steering --live
node research/conversation-evidence/structured-input-cli.mjs
```

These are research-driver flags, not Namzu CLI options. A production `run-stream`
seed process uses the real `read` tool on a 350-line manifest, with model choices
scripted. A random `RECEIPT-<UUID>` is outside its visible preview and absent
from its short summary. The file is replaced externally after that process
exits. Each case gets a copy of only the synthetic seed state and reopens the
same conversation in a new process through the built CLI Session host.

Automatic evidence recall is explicitly enabled; query resolution is disabled.
The fixture prompts deliberately name the archived DELTA record, isolating
judgment from referential query accuracy. The candidate is **scripted**, derived
from the actually recalled source. Correct candidates, unchanged values for
transformation tasks, a Unicode copy error and an instruction-like non-answer
are controlled inputs, not naturally observed model failures.

The reviewer locates the source in the candidate request, then authenticates its
quote with `readConversationEvidence` under the conversation's existing scope.
The model sees only the actual task, this bounded historical quote and the
candidate. No expected verdict or answer is sent to live inference. In the
scripted arm judgments are supplied by the fixture, validating plumbing only.
The parent compares actual verdicts against separately declared expected
verdicts after the run. Live model chunks are forwarded unchanged.

The original plain-message trials selected the last plain user message from
`requestMessages`. The updated driver uses the new retained `latestUserMessage`
field. Its steering trials supply the scenario as a host-attributed steering
message in the resumed input, while the earlier plain user message remains the
seed's different request. This checks the field through CLI composition; it is
not an interactive TUI steering-key experiment. In-flight arrival behavior is
tested separately below.

Each classification run has a 1,500-token admission allowance, three iterations,
zero correction opportunities, 20-second cancellation and a 45-second process
deadline. Its only real model call requests up to 192 output tokens with the
capability's ten-second deadline. The seed separately has 1,500 admission tokens,
three iterations and a 30-second process deadline, with zero model usage.
Admission allowance is not a hard billing ceiling.

The research policy maps both rejection and unavailable verification to
`accept: false` with explicit feedback. With zero corrections they stop as
`answer_rejected`. `unverifiable` remains distinct in the recorded model verdict;
this does not add a third SDK `AnswerReview` variant or decide how every product
should handle missing evidence. No model decision is retried or overridden by
the oracle to make the classification pass.

## Results

| Arm | Correct classifications | Model tokens |
| --- | ---: | ---: |
| Plain scripted control, `6fErs5` | 13/13 scripted | 0 |
| Plain live Luna/low, `SHoGVC` | 13/13 | 5,355 |
| Retained steering scripted control, `e7cbBP` | 13/13 scripted | 0 |
| Retained steering live Luna/low, `t49V8T` | 13/13 | 5,407 |

Each suite contains five expected acceptances (copy, lowercase, explicit Unicode
change, added prefix and a new example), six expected rejections, and two
current-state questions with different candidates that cannot be verified from
the historical quote. Both live suites match these classifications. They use
different synthetic UUIDs, so their small cost difference is not an effect-size
estimate. Total live usage is **10,762 tokens across 26 judge requests**; all
owning budget receipts report zero unresolved requests. Source replacement
files remain unchanged and before/after built-module hashes match.

For comparison, applying unconditional `candidate === sourceIdentifier` to the
eleven binary cases would reject four correct transformations/examples and
accept four incorrect unchanged answers. This is a deliberately inadequate
counterexample policy, not a measured defect in a shipped default judge. The
two current-state cases additionally require acknowledging missing evidence,
not guessing from equality or inequality to an old value.

## Kernel changes and the failure the regressions exposed

Preparation already retained the latest accepted operator input independently
of compacted history. Review did not expose it, forcing a host to reconstruct
intent from messages that might have been removed or that carry steering in a
tool result. `AnswerReviewContext.latestUserMessage` now copies that retained
input immediately before candidate dispatch. It is separate from the projected
request snapshot and does not claim to represent the complete task. Subsequent
arrivals, runtime reports and mutations to a reviewer's copy cannot relabel the
candidate. Existing checkpoint tracking restores the input after compaction.

A new regression initially failed specifically for **tool-mode structured
output**: a user message queued during the model request was never processed
before the run published its answer. Prose and native JSON took another turn.
The tool-mode settlement now drains new inbound messages and notices steering
already delivered on its tool result. It gives the model another turn before
publishing, subject to existing run limits. Review still judges the earlier
candidate against the input that preceded its dispatch. Cancellation prevents
publishing the pending candidate.

The separate `structured-input-cli.mjs` experiment (`hZPAtV`) runs the actual
built CLI Session, SDK loop and output tools with scripted model choices and
zero external inference. It queues `Use B42 now.` during a request for `Use A17.`.
All six cases (prose, tool and native, with and without a reviewer) make a second
request and settle with B42. Reviewers observe A17's instruction first and B42's
instruction second. This is behavioral CLI-host execution, not a TUI rendering
test. An initial driver launch failed before execution because root research
scripts cannot import the SDK's private `zod` dependency; the driver now uses
the public SDK schema converter.

SDK regressions cover all three review paths, both queued input and tool-result
steering, mutation isolation, compaction, goal-round/source classification,
checkpoint resume and cancellation at settlement. The cognitive-architecture
page's stale statement that reviewer exceptions fail open was also corrected
against the current runtime.

## Validation

The workspace run passed all 6,605 SDK tests, but initially failed a CLI goal
interaction test. Subsequent CLI runs exposed readiness races in two goal test
helpers: a mocked session assigned its scope before the App had enabled the
composer, so the helpers could send commands too early. The tests now wait for
the visible enabled input surface; overlay interactions wait for their own
menus. Timeouts and production CLI behavior were not changed. The focused 17
goal tests and then the default full CLI suite passed: 2,931 tests, five skipped.
The initial workspace run is therefore not reported as entirely green.

The focused SDK review/retention suite passed 36 tests, and SDK process tests
passed 264. Workspace build, typecheck and configured lint passed, as did docs
conformance, compiled documentation fences, signature exports, project
references, SDK test presence and publish metadata. These checks support the
changes above; they do not constitute a publication or a full release-gate run.

## Remaining boundary

These small, explicit tasks do not establish a general judge's error rate,
resistance to arbitrary prompt injection, reference resolution, long-task
completion or performance under ambiguous instructions. The candidate model was
scripted; this is not an end-to-end task-success benchmark. A single retained
message also cannot recover all parent goals, earlier constraints or acceptance
criteria. The CLI does not automatically install this research policy.

The practical next boundary is selecting the relevant continuing task and its
constraints when a follow-up is incomplete. Latest-input identity, authenticated
archive text and a model verdict are now available separately; none should be
silently substituted for the others.
