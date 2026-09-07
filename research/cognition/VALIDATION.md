# Recorded validation

Observed locally on 2026-09-07. The scripts are the reproducible specifications;
timings below describe one environment and are not acceptance thresholds.
The mechanism experiments below used no paid model or external database. The
later production follow-up records separate live subscription-model observations.

## Cognitive mechanisms

`node --test research/cognition/association.test.mjs research/cognition/executive.test.mjs`
passed 23 tests. They cover scoped and numerically bounded diffusion, evidence
conflicts, stale observations, unknown effects, goal changes, replay, atomic
budget refusal and separation of retrieval from outcome learning.

The real-SDK probe used one synthetic task, a scripted proposal generator and
the same seven-request cap. Its observed results were:

| Variant | Actual requests | Executed tools | Objective independently verified |
| --- | ---: | --- | --- |
| Baseline | 2 | Cached write | No |
| Without association | 7 | Cached write twice | No |
| Without outcome control | 7 | Cached write twice | No |
| Without completion gate | 2 | Cached write | No |
| Full | 7 | Cached write twice, fresh write, health observation | Yes |

All variants reported a completed SDK run, including variants that had not
met the objective. Their stop reasons differed. The final criterion check
therefore remains independent of the run's terminal status. This fixture
demonstrates the intended coupling; it provides no estimate of real-model
success rates or superiority to another harness.

An independent review reproduced and prompted fixes for omitted contradictory
receipts, counting invalidation as progress, ranking predictable polling above
interventions, and admitting events beyond the snapshot byte budget. The final
review passed. Pending-state cancellation safety was checked; the SDK adapter
does not yet exercise a genuinely blocked asynchronous tool cancellation.

## Local association cost

The resource probe ran on Linux x64, Node 24.19.0, an AMD Ryzen 9 7950X3D.
It measured 100 queries after five warmups over 256 nodes and 1,024 edges:

| Measurement | Observation |
| --- | ---: |
| Median query time | 1.34 ms |
| p95 query time | 3.29 ms |
| CPU time across 100 measured queries | 249.01 ms |
| Whole-process peak RSS | 70,088 KiB |
| Largest returned fixed-point residual | 7.49e-11 |

These costs include graph validation, normalization, diffusion and sorting.
They exclude document indexing, embeddings, language understanding and provider
inference. RSS is a process high-water mark, not incremental graph allocation.

## Storage materialization

The storage probe used the same machine and Node version with SQLite 3.53.3.
It seeded 128 selected-scope records and 64 unrelated records, each with a
4 KiB body. Three selected records matched the query; every unrelated record
also matched. Both implementations returned the same selected IDs and passed
update, archive and reactivation checks.

| Per-query application materialization | Current disk store | Experimental index |
| --- | ---: | ---: |
| Body records read for search | 128 | No payload bodies loaded for candidate selection |
| Selected payload bodies read | 3 | 3 |
| Total decoded body bytes | 536,576 | 12,288 |

The disk path also read its metadata index four times. SQLite engine page and
index reads and both paths' physical I/O are unmeasured. This demonstrates lower
payload materialization, not a corresponding physical-disk reduction.

After three warmups, 20 alternating measurements observed median/p95 query
times of 45.57/50.49 ms for the disk path and 0.089/0.205 ms for the index.
The implementations have different ranking, locking, validation and durability
costs; these numbers do not establish an equivalent production speed ratio.
Disk seeding including its index took 0.77 seconds. SQLite's per-record
transactions took 1.01 seconds plus 8.63 ms for batched index construction.
Logical file sizes were 851,726 and 1,114,112 bytes respectively. An index has
write and storage costs as well as retrieval benefits.

This was a warm temporary-filesystem experiment, with no physical-medium
identification or cold-cache measurement. The synchronous SQLite prototype
does not test concurrent writers, crash recovery or database cancellation.

## Repository checks

The implementation passed workspace typecheck, lint, build and tests, plus
the documentation conformance and TypeScript-fence checks. Lint reported 27
non-failing warnings. SDK tests passed 5,704 cases; CLI tests passed 2,248 with
two skipped. Eight SDK regressions exercise the corrected advisory inputs.

This records those checks only. Coverage, consumer-install, publishing and the
remaining release gates were not rerun for this local research commit. No push
or release is established by these results.
## Production follow-up, 2026-09-07

The source audit and real CLI workload are recorded in [PYDANTIC_REVIEW.md](PYDANTIC_REVIEW.md)
and [long-work/README.md](long-work/README.md). Unlike the experimental association
and executive modules below, the context and code-execution fixes are shipped SDK
paths. Local implementation commits are `c78fd3f0` and `c5cf4de9`; no push or publish
was performed.

Validation after integration:

| Check | Observed result |
| --- | --- |
| Workspace typecheck, lint, build | Passed; existing lint warnings remain |
| Workspace unit tests | Passed; SDK 5,746 and CLI 2,248 plus 2 skipped at that run |
| SDK coverage rerun after added advisory regression | 5,747 passed; module coverage floors passed |
| SDK process suite | 242 passed in 30 files |
| Packed standalone SDK execution | Async structured calls and constructor denial passed |
| Full consumer-install gate | Passed with previewed shipping versions, live/telemetry/sandbox/eval consumers |
| Evals | Four suites passed |
| Docs structure and fences | Passed; 24 fences and 17 package READMEs |
| Gate parity, project references, source-name audit, log standard | Passed |
| Price catalogue, test presence, publish metadata, exported signature types | Passed |
| publint | All 17 publishable packages passed |
| Installer syntax | `sh -n install.sh` passed; `dash` unavailable on this host |
| Portable workload preflight | Baseline fails seeded cases; both reference variants pass exactly their declared cases |

The installer matrix is therefore not fully verified locally. Tests establish
specific invariants, not complete request-fit guarantees, general intelligence or
an independently verified completion of the live queue task. Conversation resume
preserved work and reached 17/17 visible tests, but independent behavior remained
12/15 despite a completion claim. This is the main observed quality gap to carry
into the next executive-control experiment. No hidden failures or reference patch
were supplied during either live observation.

The source-name audit now permits one explicitly named comparison source only in
the two cognitive research pages and their index/log. Negative controls still
reject unrelated brands, unrelated pages and kernel identifiers. This narrow
exception preserves source attribution in the user-requested research.

## Verification and final-answer follow-up, 2026-09-07

Command-backed review had reproducible false-acceptance paths: interrupted
processes could exit zero, and executor/fingerprint exceptions could escape into
the generic review hook's fail-open behavior. Nine initial regression cases
failed before the fix. A real shell with a TERM handler that exits zero now
produces a timeout receipt and a rejected verdict. Run cancellation reaches the
verifier, remains cancellation at settlement and prevents new command admission
after asynchronous change detection. Diagnostic clipping includes its marker in
the configured character allowance.

Two further failing regressions exposed fingerprints that equated different
clean commits and accepted interrupted Git output. The detector now includes
the committed baseline and rejects incomplete command receipts. Its feedback
describes Git-visible scope without claiming that ignored files or external
inputs could not have changed. These SDK changes are committed as `b33dc987`.

The [verifier-assisted live continuation](long-work/gated-live-run.json) first
rejected the queue candidate at 12/15 independent checks, then passed all 15
after model repair. All 17 visible tests and protected-file checks also passed.
This used 11 requests and 117,003 reported tokens at `gpt-5.6-luna / low`, with
no guard firing. Private diagnostics were intentionally supplied; the result is
not a blind evaluation or controlled capability comparison.

That run exposed a separate CLI defect: the final stdout artifact included an
earlier rejected answer and preliminary narration. Four boundary regressions
failed before carrying the settled kernel result through `done.text`. Buffered
output now uses that value, including an explicit empty guarded answer, and
streaming consumers can read it separately from previously emitted deltas. The
CLI implementation is committed as `73de1243`.
The [real output smoke](long-work/output-live-run.json) used two low-effort
requests and 13,111 reported tokens. Preliminary narration was observed on the
provider wire while stdout contained only the requested final verification line.

Checks after these changes:

| Check | Observed result |
| --- | --- |
| Workspace typecheck, lint and build | Passed; existing warnings remain |
| SDK unit tests and coverage | 5,761 passed; module floors passed |
| Other workspace package tests | Passed |
| CLI unit tests after updating the event contract assertions | 2,251 passed, 2 skipped |
| SDK process tests | 243 passed in 31 files |
| Full consumer-install gate | Passed again, including live, sandbox and telemetry consumers |
| Evals | All four suites passed |
| Docs structure and fences | Passed; 25 TypeScript fences and 17 package READMEs |
| Gate parity, project references, source-name audit and log standard | Passed |
| Price catalogue, test presence, publish metadata and signature exports | Passed |
| Installer syntax | Passed with both system `sh` and a temporary source-built `dash` |

The previously missing `dash` check was completed without installing a system
shell: upstream tag `v0.5.13.5`, commit
`037bbdfd330017c368caf6242f977974123239b5`, was built in an owned temporary
directory and used only for `-n install.sh`. [Pinned source](https://git.kernel.org/pub/scm/utils/dash/dash.git/commit/?id=037bbdfd330017c368caf6242f977974123239b5).
The earlier all-package publint result remains applicable; no package metadata
shape changed in this follow-up. No push or publish was performed.

Remaining completion limits are explicit in [Answer verification](../../docs/sdk/verification.md):
generic custom review exceptions, forced/terminal/structured settlement paths,
uncooperative host callbacks and the absence of automatically derived complete
acceptance criteria. Original-evidence indexing, a bounded current-plan projection
and production integration of the experimental executive remain separate work.
