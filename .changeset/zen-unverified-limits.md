---
"@namzu/zen": major
---

**Breaking: Zen Go's `space-bunny-free` leaves the bundled catalogue.** Go no longer serves that id, so `findZenModel('go', 'space-bunny-free')` and `getZenModels('go')` no longer return it, and a Go request naming it fails as an unknown model. On Go, use `space-bunny`, which the snapshot now carries. Zen's own `space-bunny-free` is unchanged.

Zen now carries models that the service routes, prices and serves but that models.dev has not described yet, where it used to omit them. These models get conservative limits: 65,536 context, 8,192 output, text input, tool use on and no effort levels. They also get a new optional `ZenModel.limitsVerified: false`. Every other model leaves the field out, so existing code reads the same shape. Once models.dev publishes a model's limits, the entry uses them and the flag goes away. Tool use is assumed for these models, so one that cannot call tools fails when it runs. Models are still never carried when their price cannot be read or the service does not serve them, and a missing price never becomes zero.

The free rule changed earlier without a changeset. Any Zen model priced at zero in the active catalogue is now offered without a key through the experimental request path, where previously only a fixed list of eight ids was. An id outside the old list used to be refused without a key; now it can be selected, though the gateway may still refuse it.

The bundled snapshot adds `mimo-v2.6-flash-free`, `exo-free`, `fledge-alpha-free`, `ling-3.1-flash-free`, `grok-4.7`, `gpt-6.1-sol`, `claude-sonnet-5-5` and `claude-haiku-5-5` on Zen. On Go it adds MiMo V2.6 Flash and Pro, `claude-haiku-5-5` and `space-bunny`.

`parseZenCatalogue` accepts `limitsVerified: false` in a stored copy and rejects any other value. An older `@namzu/zen` rejects any stored copy that contains the field and falls back to its bundled snapshot.
