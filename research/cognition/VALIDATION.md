# Recorded validation

Observed locally on 2026-09-07. The scripts are the reproducible specifications;
timings below describe one environment and are not acceptance thresholds.
No paid model or external database was used.

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
