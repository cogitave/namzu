---
'@namzu/zen': minor
---

`muse-spark-1.3` no longer advertises the `max` reasoning effort.

Upstream dropped it from the model's own menu, so a regeneration writes
`['minimal', 'low', 'medium', 'high', 'xhigh']` where it wrote six values. A caller
that passes `effort: 'max'` for this model is now refused with the refusal the
driver has always given for an unadvertised level — *"The selected model does not
advertise this reasoning effort level."* Pass a lower level for this model, or use
a model whose menu still carries `max`.

**Why `minor` rather than `major`.** The catalogue's own rule, in
[Zen and Zen Go](../../docs/sdk/zen.md), is that a removal is `major` *because a
carried id stops resolving*; an addition or a repricing is `minor`. This model
still resolves — `getZenModels()` and `findZenModel()` return it unchanged, its
id, protocol, prices, context window and tool support are identical, and the
public `ReasoningEffort` union in `@namzu/sdk` still carries `max` for the models
that do advertise it. The page's rule has two buckets, and this is the one that is
not a removal of a carried id: an addition, a repricing, or any other change that
leaves a carried id resolving is `minor`. Nothing was removed from the API and no
default changed.

**No code changed.** The only edit is the generated catalogue, regenerated rather
than hand-edited: `scripts/generate-zen-models.mjs` derives it from the live
documents and `models.dev`, which is also what turned this into a red gate before
anyone noticed by hand.
