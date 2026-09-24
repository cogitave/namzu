---
'@namzu/anthropic': patch
---

`claude-opus-5-5` can no longer be asked to turn thinking off. The driver treated it like `claude-opus-5`, which accepts `thinking: { type: 'disabled' }` at effort `high` or below. Opus 5.5 cannot stop thinking and answers `disabled` with a 400 at every effort level.

What changes for you:

- **A `thinking: { type: 'disabled' }` intent is left out of Opus 5.5 requests.** It used to be sent, and the request failed with `"thinking.type.disabled" is not supported for this model`. Now the model runs its default adaptive thinking, as it already did for the Fable and Mythos families. To spend less on thinking, lower `effort`. Note that Opus 5.5 defaults to effort `medium` when you leave `effort` unset.
- **`disabled` with effort `xhigh` or `max` is no longer refused on Opus 5.5.** It used to fail before sending with `effort "max" is not supported by model "claude-opus-5-5"`, although the model accepts all five levels.
- **`resolveThinkingCapability('claude-opus-5-5')`** returns `canDisable: false` and all five levels in both `effort` and `effortWhenDisabled`. `provider.effortLevelsFor('claude-opus-5-5', { type: 'disabled' })` returns all five levels.
- **A later Opus id** (`claude-opus-5-6`, `claude-opus-6`) resolves the same way.

`claude-opus-5` keeps accepting `disabled` at `high` or below.
