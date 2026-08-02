---
'@namzu/sdk': major
---

A model-graded judge, and a failed measurement that stops reading as a zero.

Every scorer in the harness was a pure function over the run, which is what
makes them reproducible — and what makes them unable to say whether an
answer is *good*. `containsScorer` can check that a required phrase appears;
it cannot tell a correct explanation from a fluent wrong one. The dimension
most worth guarding had no scorer behind it.

**`judgeScorer`** grades an open-ended answer with a model. Four choices in
it are deliberate, because each is where these usually go wrong:

- The **rubric is required**. A judge asked to rate "quality" rates fluency,
  which correlates with little worth measuring and drifts whenever the judge
  model changes. It throws rather than run without one.
- An **ordinal scale, not a 0..1 float**. Models place a continuous score
  poorly and cluster on round numbers; a short scale against a written
  rubric is a judgement they can make. The default of 4 is even on purpose —
  an odd scale has a midpoint, and a midpoint is where an uncertain judge
  parks.
- **Temperature 0**, because sampling noise is indistinguishable from a
  regression.
- **Truncation disclosed in the prompt**, so the judge does not mark an
  answer down for an ending the harness removed.

A grade outside the scale it was given is an error rather than a clamp: a
judge that misread the scale did not apply the rubric either.
`details.judgeTokens` carries what the judging cost.

**A failed measurement is no longer a measurement of zero.** A judge is a
network call, so it can fail to answer at all — and scoring that `0` says
"the run was bad" when the truth is "we do not know". One rate limit would
turn a green suite red and send somebody hunting a regression that never
happened.

- `Score.unavailable` marks a judgement that could not be produced. It is
  excluded from the case mean's numerator **and** denominator.
- `CaseResult.status` is `'passed' | 'failed' | 'inconclusive'`, and a case
  where every scorer was unavailable is inconclusive rather than failed.
  `CaseResult.passed` remains, true only for `'passed'`.
- `ExperimentReport.inconclusive` counts them, and `formatReport` surfaces
  that count **above** the failures — it means every number below covers
  less evidence than it appears to.
- `byScorer` averages each scorer over the cases it actually judged, and
  omits one that was never available rather than reporting it as `0`.

A run that **threw** still scores zero: that is a real failure of the thing
under test, not of the measurement.

Breaking: `CaseResult` gains a required `status`, `ExperimentReport` gains a
required `inconclusive`, and a scorer that throws now reports as unavailable
instead of scoring zero.
