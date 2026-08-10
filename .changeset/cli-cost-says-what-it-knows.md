---
'@namzu/cli': patch
---

`/cost` and the status bar stop reporting an unpriced run as a free one

The kernel now prices runs from a built-in catalogue and reports
`costInfo.unpricedTokens` when it cannot. The CLI was still narrowing that
record to a single number and printing
`'$0.0000 (this provider reported no price)'` for any total not above zero —
so the operator-facing surface kept making the claim the kernel had just
stopped making.

Two things were wrong with that line beyond the number. A run on local
inference costs nothing and is not the same event as a run nobody can price,
and both landed on the same sentence. And the sentence asserted something
about the provider that no code had checked: what is known is that namzu has
no rate for the model, which is a statement about this side of the wire and
points at a different fix.

`/cost` now distinguishes three states — a real cost, a measured zero, and not
known — and marks a partly-priced run as a floor rather than an answer. The
status bar shows `$?` rather than omitting the figure, because a missing cost
on a line read at a glance is read as no cost.

`patch`: no exported symbol changes. The internal `AgentEvent` usage variant
carries the kernel's `CostInfo` whole instead of a flattened `costUsd`, but
neither it nor the renderers are part of `@namzu/cli`'s public barrel — the
package exports a CLI, and its behaviour is corrected, not extended.
