---
'@namzu/sdk': minor
---

An eval score now carries the interval a reader should apply to it

`ExperimentReport` reported a mean and nothing else, so two runs three points apart read as a difference. At the n a hand-built suite has, that is usually the same run twice, and there was no number on the page that would have said so.

`ExperimentReport.uncertainty` carries the standard deviation, the standard error, the 95% margin and the interval, and `formatReport` prints it beside the mean. Computed over the same cases the mean is computed over — an interval drawn from a different denominator does not belong to the number next to it.

Two decisions worth knowing:

**The interval uses Student's t, not 1.96.** At n=5 the true two-sided multiplier is 2.776, so a normal-approximation interval is nearly 30% too narrow exactly where a suite is small enough for that to mislead. Eval suites are small.

**It says it assumes the cases are independent, because they may not be.** Clustered standard errors run up to 3× the naive figure when cases come in related groups — several derived from one scenario, one document, one seed. This harness has no grouping key on a case, so there is nothing to cluster on and the naive figure is what is reported. Where a suite builds several cases from one source, treat the interval as a floor.

A single case reports no interval at all rather than ±0. One case has no spread to measure, and ±0 would be the most confident-looking output a suite can produce from the least evidence it can have.

Reference: Evan Miller, "Adding Error Bars to Evals" (arXiv:2411.00640).
