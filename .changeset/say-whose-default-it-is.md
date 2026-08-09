---
'@namzu/cli': patch
---

**`namzu doctor` now marks an unpinned model `(namzu default)` instead of
`(default)`, and the picker's notices stop calling it the provider's.**

A chain member that omits `model` gets a value out of namzu's own registry — a
table compiled into the release. It is resolved at launch but never refreshed
from the provider, so between releases it can name a model the provider has
superseded.

Every surface that showed that value called it "the default" or "its default",
which reads as the provider's current one. It sends an operator who did not
expect the model to go looking at the provider, where there is nothing to find.
The thing to do is give that member an explicit `model`, and the surfaces now
say so:

- `namzu doctor`'s chain readout prints `<model> (namzu default)`.
- The `/model` picker's four "could not list" notices say "showing namzu's pick
  for it" rather than "showing its default" — they sat beside a row already
  labelled `(namzu default)` and contradicted it.
- `docs/cli/providers.md` no longer says an omitted `model` "tracks the default".
  It does not track anything; it moves when you upgrade namzu.

If you parse `namzu doctor` output, the marker string changed.
