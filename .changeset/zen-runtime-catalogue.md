---
"@namzu/zen": minor
---

Derive the Zen and Go model catalogue at run time, opt-in. The new `@namzu/zen/catalogue` subpath exports `fetchZenCatalogue()`, which reads the same five sources the bundled snapshot is generated from (both documentation pages, models.dev and both `/models` answers) with a deadline and byte limit per source, and returns a whole validated catalogue plus a report, or rejects. It never returns a partial list. `buildZenCatalogue()` does the same derivation from texts you fetched yourself, and `parseZenCatalogue()` re-admits a stored copy strictly.

Pass the result as the new `ZenConfig.catalogue`, or a function returning it, and the provider checks it before the bundled snapshot for routing, anonymous admission, listing, context windows and effort levels. With a runtime catalogue, a served id that no source gives a wire format for is listed as `<id> (no known wire format)` and can be called only with an explicit `protocol`; the bundled snapshot's entry for such an id, if it has one, is not used. A model name carrying a control, format or line-separator character is refused, in a derivation and in a stored copy.

Nothing changes unless you opt in. Importing the package, constructing a provider and `getZenModels`/`findZenModel` still read the bundled snapshot and make no network request. Without `catalogue`, `listModels()` returns what it did before. `ZEN_OMITTED_MODELS` (the reviewed omissions the snapshot was generated under) is now exported from `@namzu/zen` and `@namzu/zen/models`. The bundled roster is unchanged: 61 Zen and 28 Go models.
