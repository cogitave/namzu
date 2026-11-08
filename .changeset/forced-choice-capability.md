---
"@namzu/sdk": minor
"@namzu/anthropic": minor
---

A run that stalls is pushed into acting without failing the turn on a model that refuses a forced tool choice.

`LLMProvider` gains an optional `acceptsForcedToolChoiceFor(model, thinking)`. The kernel asks it before it requires a tool call on an action step, and when the answer is `false` it keeps the step at low effort and asks the model in words instead of sending `toolChoice: 'required'`. A provider that does not declare it is treated as taking the choice, so every existing driver and custom provider behaves as before. The Anthropic provider declares it from the same rule it already rejects by, so it is `false` for Opus 5.5, Fable 5.1, Mythos 5.1 and any request that carries manual extended thinking; before this, a stalled run on those models failed the turn with `forced_tool_choice_unsupported`.

Additive, hence minor: nothing is removed or changed for a caller. A wrapper that rebuilds a provider and wants forced steps to keep working on these models forwards the new member, as the SDK's own retry, idle-timeout, fallback and window-marker wrappers now do.
