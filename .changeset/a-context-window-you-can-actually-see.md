---
'@namzu/sdk': minor
---

`token_usage_updated` now carries the current context size and the window it is measured against.

A host built a context indicator, and it could not have been right. The event
carried `usage` — **cumulative run spend**, summed over every turn, monotonically
increasing and untouched by compaction — and nothing about the size of the
conversation being sent. So the host divided cumulative spend by a context
window guessed from a substring of the model name, and rendered the result as an
unqualified percentage, continuously.

Both terms were wrong, and the numerator was the worse of the two: a guessed
window is wrong by a bounded factor, while cumulative spend grows without limit
and pins such an indicator toward full on any long run regardless of how much
room the conversation actually has. It would have been most wrong exactly when
someone needed it most. In the other direction, a driver that reports no usage
shows 0% for a conversation that is really there.

The kernel already computed the right numbers on every iteration and kept them
to itself. `measureContext()` is now exported, and the event carries four new
optional fields: `contextTokens`, `contextMeasuredBy` (`'provider' | 'estimate'`),
`contextWindowTokens` and `windowSource` (`'config' | 'model-table' | 'default'`).
They are named apart from the cumulative figures beside them deliberately —
reaching for the wrong one should be a visible mistake, not a plausible guess.

**They are absent when the run has no compaction configuration**, because nothing
then resolves a window and inventing one would be the guess this replaces. A
surface should show what it can name rather than a fraction it cannot ground.

**A fraction is only as honest as the weaker of its terms.** `contextMeasuredBy`
and `windowSource` exist so a surface can pass that on rather than presenting an
estimate as a measurement. Nothing existing changes: `usage` and `cost` are
untouched, and the new fields are additive and optional.
