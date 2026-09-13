# Resident claim verification and continuity

Date: 2026-09-13. Baseline checkout: `985db494`. This experiment adds an explicit
host policy for machine-checkable claims. It does **not** measure general model
intelligence, prove arbitrary prose true, or finish the autonomous-kernel roadmap.

## Reproduced gap

`verification-baseline.mjs` drove the actual compiled CLI with a scripted provider.
The workspace's `package.json` contained version `3.0.0`. The provider answered
that the current version was `1.0.0`, with `kind: complete`. Ordinary resident
decision-shape review accepted it and persisted a complete pursuit. No factual
verification policy existed in that invocation. This is a reproducible host
acceptance boundary, not evidence that Luna independently made this error.

The original result is retained in the curated dataset with its source hashes.
The new policy is opt-in; the unconfigured baseline behavior remains unchanged.
Consequently, this is a comparison of explicit host contracts, not a controlled
claim that a prompt alone improved model accuracy.

## Primary implementation consulted

The local Pydantic AI Harness checkout was inspected at
`c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504`:

- [Output guardrail implementation](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/guardrails/_capability.py)
  accepts host-written guards and explicit allow/block/replace/retry results.
- [Guardrail documentation](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/docs/guardrails.md)
  describes output retry using the run's existing retry budget, and explains that
  final guard decisions cannot retract already-streamed chunks.
- [Output guardrail tests](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/tests/guardrails/test_output_guardrail.py)
  exercise host acceptance and rejection through an actual agent run.

These are pinned source observations, not a claim about the latest release.
The applicable lesson is to keep the acceptance predicate explicit and owned by
the application, then use the existing repair mechanism. Neither a generic guard
callback nor a model judge supplies factual authority by itself. Namzu already
had `reviewAnswer`, structured-output review, and command gates; those contracts
and the earlier request-evidence research were read before adding a supplier.

## Implementation and limits

The SDK now exposes `createJsonClaimVerifier`. For each configured requirement,
acceptance requires a fresh successful host observation, matching scope/run/
iteration/request/source, complete current JSON bytes, candidate/selected-field
equality, and an optional expected postcondition. All requirements must pass.
The helper computes the hash of the bytes it actually parses. Source names and
pointers are host-selected, never taken from the candidate as read authority.

Observations are sequential and bounded by total bytes and a whole-review
deadline. Repeated checks make fresh reads. Timed-out, cancelled, foreign,
historical, malformed or incomplete observations cannot produce success. A late
observer remains outstanding and blocks further checks until drained. It cannot
be cancelled forcibly by JavaScript; the CLI keeps uncertain ownership if cleanup
is not established. An adapter that lies about its source or ignores its capture
bound remains a host defect; matching metadata is not cryptographic authentication.

CLI `resident run/start --verify <manifest>` snapshots the explicit policy and
passes it through managed-worker IPC. It authorizes bounded host reads of selected
workspace JSON files, separately from model-tool permission/sandbox handling.
It does not grant model tools additional authority. Checks run after configured
command gates. Successful completion must match the accepted answer's exact hash.
The immutable finish receipt records checked values, scope, observation hashes
and times; durable agenda settlement is still distinct from a callback receipt.

Only explicit structured claims are verified. A correct `claims.version` does
not prove an arbitrary surrounding summary or the whole objective correct.
Observation time is not atomic check-and-use, future truth, or hostile-filesystem
confinement. Safe integers are the only supported numeric values; exact decimals
belong in strings. Full configuration and limits are documented in
[SDK verification](../../docs/sdk/verification.md#explicit-json-claims) and
[resident CLI work](../../docs/cli/resident-work.md#configured-claim-verification).

## Measured outcomes

The measurements ran on Linux with Node 24.19.0; no Windows or TUI validation is claimed for this command-only addition. Every trial used an isolated `NAMZU_HOME` and synthetic workspace. Network search
was off, the model tool mode was read-only, and no personal resident was changed.
Each probe fingerprints production modules before and after; all builds stayed
stable during their individual measurements. All admitted attempts, including
intentional failures and cancellations, remain in the records.

| CLI scenario | Observed outcome |
| --- | --- |
| Scripted stale claim, then corrected claim | Rejected `1.0.0`; completed with verified `3.0.0` |
| Source changes after candidate generation | Rejected the previous `3.0.0`; completed with `4.0.0` |
| Missing source | Initial completion rejected; blocked disposition retained |
| Repeated false completion | Four proposals; `answer_rejected`, no settled completion; claim held |
| Luna/low ordinary current-value task | `read`, then complete with verified `3.0.0` |
| Scripted wrong first proposal, then Luna/low repair | Feedback delivered; Luna read the source and corrected it |
| Luna/low missing source | `read` returned ENOENT, `glob` found none; blocked |

The first three live cases used **9,585**, **9,711**, and **14,553** provider tokens.
A final-build current-value smoke used another **9,604**. Total live-provider
usage: **43,453 tokens**, nine actual live stream requests across four admissions.
The repair admission also contains one deliberately scripted, zero-token first
proposal. No live provider failure was hidden or rerun. These counts are recorded
token usage, not a subscription billing calculation or a score estimate.

During final review, a new regression showed that a synchronous observer could
delay the deadline timer and still be accepted. The test first failed (35 other
tests passed), then passed after adding monotonic elapsed-time checks. The three
initial live cases preceded this deadline refinement. Afterward, all four
scripted CLI cases, a live current-value smoke, and the continuity experiment
were repeated on the final production build. This avoids implying that all
initial live cases were collected from the exact final module bytes.

## Controlled continuity, not a long-duration soak

Two executions of `verification-continuity.mjs` ran through actual managed CLI
worker processes, lasting **89.095 s** and **90.469 s**. Each involved:

- Two pursuits and six accepted-input waves, separated by real idle periods.
- Fourteen successful waiting steps; each wave reached both admitted contexts.
- Three distinct worker processes, with normal stop/restart between waves.
- One cancellation after a request was actually running. Its claim remained
  unresolved, with a null decision, null usage receipt and confirmed cleanup.
- Inspection of that exact finish record before explicit `reconcile`; no action
  replay. Two fresh steps then completed with observation receipts for version `8`.

Each execution recorded **17 distinct claim IDs and 17 run ledgers**: 14 waits,
one interrupted admission, two completions. Models were scripted and issued no
network inference, so model consumption was zero by construction. The missing
usage receipt on cancellation was preserved as missing, not manufactured as zero.
The operator's reconciliation consumes that pending wake batch under the existing
settlement contract; the experiment does not claim the cancelled wake was
automatically re-delivered in the final prompt.

The final repetition also edited the verification manifest after worker startup.
The worker continued under its original validated snapshot, including the two
completion receipts, while the file on disk had an invalid replacement policy.
This checks that a file edit cannot silently expand an active worker's authority.

These are bounded lifecycle regressions, not evidence of hours-long reliability,
independent initiative, automatic factual verification of prose, or a lifetime
accounting dashboard. Those larger roadmap items remain separate work.

## Reproduce and inspect

After building the workspace:

```sh
node research/resident/verification-baseline.mjs
node research/resident/verification-cli.mjs
node research/resident/verification-cli.mjs --live
node research/resident/verification-cli.mjs --live --case current
node research/resident/verification-continuity.mjs
node --test research/resident/verification-audit.test.mjs
```

Live commands require the normal locally available Codex credentials. The other
experiments use scripted providers through a process-local preload. It replaces
the provider only in those isolated probe processes; it does not modify installed
packages, copy credentials, or alter the production registry.

`verification-report.mjs <baseline-root> <trial-root> ...` collects the printed
temporary roots into [verification-results.json](verification-results.json).
It retains synthetic sources, public final answers, scoped receipts, run usage
and lifecycle facts; it excludes private reasoning and full provider requests.
The independent [auditor](verification-audit.mjs) validates answer/source hashes,
scope, timestamps, noncompletion, input delivery and consumption. Nine tests
include deliberate tampering with answers, sources, claim scope, usage and wake
delivery. This tests record consistency, not semantic correctness of prose.

Validation includes whole-workspace typecheck, lint, build and tests, SDK process
tests, documentation checks, final focused SDK/CLI regressions, and the record
audit. The deadline refinement has an explicit failing-then-passing test. Initial
integration type errors (missing public exports and a test factory import) were
fixed before live probes. No push, publish or release-only gate claim is made here.
