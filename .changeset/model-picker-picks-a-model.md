---
'@namzu/cli': minor
---

`/model` now picks a model.

It re-opened the **provider** list, and the model was always the provider's
default. So someone who wanted a different model typed the obvious command,
chose a provider, and nothing changed — the command was named for the thing it
did not do.

The chain was wired end to end except one link: `Picker`'s `onSubmit` accepted
`{ provider, model? }`, the app wrote `model` into preferences, and a session
read `prefs.model ?? entry.defaultModel`. The picker never produced a model.

`/model` is now two steps — provider, then model. `esc` steps back to the
provider list rather than out. The model step starts on the one already in
force, so re-opening it does not quietly reset you to the default. Your choice
is written to `~/.namzu/preferences.json` and is what the next turn is sent with.

**When the list is unavailable, the picker says which unavailable it is.** Asking
a provider for its models can end four ways — it answered with none, it did not
answer inside 3 seconds, the driver has no listing capability, or it errored —
and all four used to arrive as an empty array. Three of them are not "this
provider has no models", and the timeout is the one you can do something about.
Each now shows its own line, and the provider's default stays selectable in every
case, so the step is never a dead end.

Host UIs consuming `namzu providers-json` are unaffected: that command still
renders any failure as an empty list, and is now the only caller that discards
the reason.
