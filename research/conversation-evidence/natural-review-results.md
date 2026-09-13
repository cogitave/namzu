# Natural CLI candidates and honest limit settlement

2026-09-13. Local terminal research with built CLI Sessions; not a benchmark
score or a default factual judge. Raw synthetic records, requests, outcomes,
usage and build fingerprints are in `natural-review-results.json`.

## Method

`source-support-review-cli.mjs --live --natural` sends **every candidate and
judge request** to `gpt-5.6-luna` at `low` effort. Only the original archive
records and compacted history marker are scripted. No tool is removed to force
an answer. The source documents contain synthetic identifiers, with matching
seeds across the claim trials; session IDs, recorder times and temporary paths
vary. These are single independent samples, not identical provider requests or
a statistically meaningful comparison.

Each natural trial has a 26,000-token admission allowance, six iterations,
1,024 output tokens per candidate, and a 120-second outer deadline. The optional
review independently searches the fixture's known, authorized original run,
re-reads exact bytes, validates scope/whole-part retention and sends up to four
records to the existing run-metered judge. This is not evidence that all these
records reached the candidate's final request. The judge asks for 192 output
tokens, has the callback's ten-second deadline and permits one correction.
Sources and fingerprinted production files remained unchanged within each run.

## Observations, including failures

| Trial | Actual outcome | Reported tokens |
| --- | --- | ---: |
| Natural claim-only baseline, review disabled | Two searches, unsupported file-value assertion, identifier's final character omitted; `end_turn` | 23,914 |
| First natural review attempt | Two searches and an unsupported candidate; research callback failed before judge inference due to reading `excerpt` instead of search's `text` | 24,247 |
| Natural review after correcting the research callback | Three searches, exact but unsupported file-value assertion; **zero reviews** and incorrectly reported `end_turn` | 33,354 |
| Same recorded candidate/tool-call/usage sequence replayed after the SDK fix | Actual conversation searches ran; closing text retained with **`token_budget`**, zero reviews | 33,354 synthetic, zero live |
| Natural direct-observation control after the fix | No model-requested search; exact answer from recalled observation, one accepted review, `end_turn` | 7,911 |

The callback setup failure is not a judge verdict or product-provider failure.
After fixing the mapping, eight offline controls checked archive revalidation
before another live attempt. Their candidate/verdict transport is scripted and
does not measure semantics. The raw artifact includes the failed attempt.

The corrected claim trial consumed 24,081 tokens across three requests. This
crossed the 90% warning threshold while remaining below 26,000. The guard then
requested closing prose, which deliberately bypasses prose review. A fourth
already-admitted response raised measured usage to 33,354. Admission allowances
are not provider-side billing ceilings. The defect was reporting this forced
closing path as normal completion, not the intentional review bypass itself.

Replay uses `--replay=<original-result.json>` with the same seed and case. It
reconstructs only the recorded conversation-search calls and candidate outputs,
using their original usage receipts as **synthetic accounting input**. Searches
execute against a fresh scoped archive. Embedded old run addresses and other
tool names are refused. It adds no vendor calls and does not re-evaluate accuracy.

The positive control consumed 7,523 candidate tokens and 388 judge tokens, with
6,656 cached input tokens in the candidate call. Across all four live attempts,
including the invalid setup, the provider reported 89,426 tokens (19,968 cached).
Do not count the replay's synthetic receipts as additional vendor consumption.
These trials establish neither a cost saving nor an improved factual error rate.

## Changes and actual TUI execution

The SDK now retains the warning guard's `token_budget`, `cost_limit` or `timeout`
reason when closing prose bypasses review. It retains the text and does not
pretend a prior rejected candidate was accepted. Cancellation retains precedence;
validated native structured output keeps its separate reviewed settlement path.

A real 100-column, 28-row PTY then exposed a second defect: `limits` loaded from
`NAMZU_HOME/config.yaml` never reached the TUI session. A deterministic transport
expected the second request to forbid tools after its scripted 950-token first
request, but the unlimited session still allowed them. This initial assertion
failure is retained as a failed control, not a successful TUI test.

The CLI now carries the resolved limits through the launch context and App's
session factory, including trusted project resolution. This is a CLI major
changeset: previously configured limits did not constrain interactive runs.
The omitted defaults are unchanged. Headless provider-wait policy is unchanged.

`forced-close-tui-fixture.mjs` was rerun with the same isolated workspace and
1,000-token config. The actual `read` tool read `receipt.txt` once. The second
request had `toolChoice: none`; closing prose was retained and the terminal
showed one `Run stopped` notice. `/cost` showed 990 tokens and a 1,000 limit.
The composer returned idle, the file remained unchanged and `/exit` exited zero.
The recorded terminal was replayed through installed `@xterm/headless`; the
artifact contains the final frame. This is real CLI/TUI execution with scripted
provider transport, **not** live inference or a factuality score.

Regression checks cover warning reasons, prior review rejection, cancellation,
native-output acceptance, config bootstrap/trusted workspace resolution, resume
launch and the App-to-session hop. The first cost/native test fixtures required
correction: the cost sample was on a floating-point threshold and the mock did
not advertise native-output support. Their corrected controls passed.

Workspace tests passed, including 6,682 SDK tests and 2,955 CLI tests (five CLI
skips). Two pre-existing cost/provenance tests expected the incorrect closing
`end_turn`; only those reason assertions changed, and their pricing/provider
assertions still pass. Typecheck, lint, build, documentation conformance and
compiled documentation fences passed. Lint retains existing warnings. This is
local verification, not all release gates or a published package.

## Decision and remaining work

Keep the extra factual judge opt-in. One reviewed success with direct evidence
does not demonstrate recovery of natural unsupported claims. The negative
trial reached the closing threshold before review could run. Explicit searches
also return low-level `source` tags without the automatic recall's plain
`recordKind` labels. Investigate that consistency and redundant searches before
spending more calls on blanket judging. Neither record completeness nor correct
execution settlement proves the candidate's factual claim.

[Pydantic AI Harness conversation search](https://pydantic.dev/docs/ai/harness/conversation-search/)
was checked directly: it reads persisted history on demand, scopes searches to
the conversation by default, and returns provenance with matched excerpts.
This supports preserving source identity through retrieval; it does not imply
that retrieval validates every claim in a returned message. Namzu's local
findings and changes above were derived from its code and execution traces.
