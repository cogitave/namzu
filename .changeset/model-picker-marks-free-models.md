---
'@namzu/cli': minor
---

The model picker marks a zero-priced model `(free)`, and its search finds the
word.

OpenRouter's public catalogue serves 445 models and 25 of them are priced at
zero for both input and output. The picker listed all 445 and could not tell
you which: the listing it built dropped the price the driver had already
parsed. A row now carries `(free)` when its listing reported `0` for both
prices, and `free` in the search box returns those rows — including the ones
whose ID and display name never spell the word, which is how
`google/lyria-3-pro-preview` becomes findable at all. Nothing is reordered or
hidden: the provider's order is the screen's order, and the marker only adds
words to a row that was already there.

**This changes what the search matches**, and that is why it is not a patch.
The filter is documented as matching a row's ID and display name; it now also
matches the note beside the row. Everything that matched before still matches
identically — the same words, the same order, the same rows returned by
identity — but a query can return more than it did. Typing `default` finds the
row marked `(namzu default)`, and `free` finds every row marked `(free)`,
where before both matched only rows whose ID or name happened to contain the
word. Nothing needs to be done about it unless you drive this screen from a
script that assumed a query's result set; if you do, the new matches are
additive, so a result you were using is still in it.

It is not a `major` because no exported symbol, CLI flag, config key, default
or wire shape moved. `ModelListing`'s `ok` arm gained two optional fields —
optional deliberately, since `ModelInfo` requires both prices and a required
price is one a driver has to invent — and the picker is a screen, not an API.

One thing to know before you trust the badge. The note reports what the
provider's own listing said about its own catalogue, and a driver that reports
zero for every model it lists gets a list marked free wholesale. Four drivers
in this repository do exactly that today (`anthropic`'s live path, `openai`,
`codex`, `deepseek`); the fix is to make the price optional in `ModelInfo` and
have those drivers omit it, the way `9d6c482c` did for `contextWindow`, and
that is an SDK change with its own bump rather than part of this one.
