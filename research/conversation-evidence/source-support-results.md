# Source-support review through the CLI Session

2026-09-13. Local research, not a default review policy or a benchmark score.
The executable is `source-support-review-cli.mjs`. The machine-readable
`source-support-results.json` retains the synthetic inputs, actual returned
judgments, usage, terminal events and build hashes.

## Method

Each case starts an isolated built CLI Session with a compacted history marker
and separate scoped RunDiskStore records. Records and the **first candidate
answer are scripted**. Automatic recall supplies source records to the actual
request; the existing `reviewAnswer` callback validates their scope, exact text,
non-preview retention and whole-part coverage through `readConversationEvidence`.
Only then does its existing metered `generateText` capability ask Luna low to
judge the candidate. No oracle result is substituted for a live judgment.

The eight first-pass controls allow no correction, with a 5,000-token run
budget and 30-second outer deadline per case. Each judge call requests 192
output tokens and inherits the callback inference deadline. Rejected candidates
terminate as `answer_rejected`; this is expected, not an execution failure.
The separate correction trial permits one retry and uses a 20,000-token run
budget and 90-second outer deadline. Its second candidate and both judges are
live. Source archive bytes and fingerprinted build files stayed unchanged.

## Observed results

| Trial | Observed result | Reported tokens |
| --- | --- | ---: |
| Eight controls with task/candidate as strings | 7/8 first verdicts matched the predeclared expectations | 3,591 |
| One follow-up identifying task speaker and candidate speaker/addressee | Correctly rejected the reversed-speaker answer | 451 |
| One unsupported-file-claim correction, explicit speakers | Rejected claim, generated qualified answer, accepted corrected answer, `end_turn` | 8,851 |

The failed first-pass case matters: the judge accepted “You told me…” even
though the source was an assistant statement and the user asked what the
assistant had said. The separate follow-up changed only the input framing to
explicit speakers, but used a fresh synthetic identifier and a new inference.
It is one successful follow-up, not evidence of a generally fixed error rate.

The other controls covered unsupported file claims, properly attributed claims,
honest uncertainty, direct historical observation, a tool quoting a claim,
conflicting sources and an altered Unicode identifier. Their successful verdicts
are useful controls, not a guarantee of truthful future answers.

In the correction trial, the main retry consumed 7,926 tokens (3,584 cached);
the two judges consumed 448 and 477. The answer explicitly distinguished the
archived assistant claim from an unavailable earlier file observation. These
numbers do not establish a net cost saving against an uncontrolled baseline.

## Decision and remaining boundary

Keep review opt-in. A blanket extra judge call is not justified by these small,
scripted-candidate controls. Improve what existing reviewers can actually see,
then evaluate natural failures and false rejections under matched budgets.

The nearby advisory executor had a separate deterministic input defect:
interpolating a rich tool-result array produced `[object Object]`; assistant
tool-call-only records became a generic stub; its window counted array elements
rather than serialized text. The SDK projection fix preserves public roles,
host provenance, calls and result status and budgets the rendered records.
This change adds no inference and does not install a CLI factual judge.

## Built SDK advisory execution

`advisory-history-smoke.mjs` invokes the built SDK query from a terminal. It uses
one actual filesystem read returning a text block and an image block, scripted
main-model turns, and an optional single live advisor. It uses CLI credential
discovery to construct the driver, but **does not run the interactive CLI**.

The offline transport control and live `--live` run both completed with
`end_turn`, exactly one read and one advisory request, unchanged fixture bytes,
unchanged build fingerprints, and attributed advice in the next main request.
The live Luna low advisor used 587 tokens (473 input, 114 output). It selected
the exact observed code, distinguished the assistant's `CLAIM-ONLY` guess and
explicitly said the projection contained no image pixels. Main-model behavior
was scripted; this verifies the advisor input and one returned judgment, not
an autonomous end-to-end task success rate. The run limit was 3,000 tokens,
three iterations, 30 seconds and one advisor call capped at 256 output tokens.

Two setup attempts failed before vendor inference: the initial script imported
`zod` from the workspace root where it is not installed, then a first live
attempt constructed the driver before registering it. The corrected script
uses the SDK schema adapter and CLI provider registration. These were research
script setup errors, not successful calls or product-provider failures.

The full workspace tests passed, including 6,669 SDK tests and 2,951 CLI tests
(with five CLI skips). The 84 focused advisory checks include trigger and tool
consultations, cancellation/idle timeout and shared token accounting. Typecheck,
lint, documentation conformance and compiled fences also passed. Lint retained
existing warnings. These checks do not imply all release gates or publication.

## Primary-source comparison

[Pydantic AI Harness trajectory judge source](https://raw.githubusercontent.com/pydantic/pydantic-ai-harness/main/pydantic_ai_harness/trajectory_judge/_capability.py)
was read directly. It snapshots the request trajectory at cadence, runs at most
one concurrent evaluation per judge, shares usage accounting and cancels work at
run end. This motivates checking input fidelity and lifecycle before adding a
new control loop. Namzu's existing advisory loop is different; this patch does
not implement that concurrency design or claim parity with it.

[RAGTruth](https://arxiv.org/abs/2401.00396) motivates distinguishing a retrieved
passage from an answer supported by that passage. This local test does not run
its dataset, reproduce its detection metrics or train a classifier.
