---
"@namzu/cli": minor
---

Let the main interactive agent change the current conversation's model
through `switch_model`, so a request such as “gpt-5.6-luna’ya geç” can use
the normal model-selection path. The tool accepts an exact model ID and
optional provider, prefers the current usable provider, and returns choices
when another provider must be selected explicitly.

An accepted request is queued until the active turn and its persistence
settle. Successful application preserves conversation identity and history
and resets reasoning effort to the new model's default. Cancellation,
conversation departure or replacement failure retains the current model;
active delegated agents or background jobs prevent the switch.
Conversational switches do not change saved defaults and are unavailable
to headless runs and subagents.
