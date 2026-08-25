---
'@namzu/sdk': minor
'@namzu/cli': minor
'@namzu/openai': major
---

Publish a model-owned reasoning-effort default alongside each exact menu and preserve it through retry, idle-timeout, and fallback decorators. Fallback chains expose a default only when every usable member agrees inside the common menu.

Add non-wrapping Shift+Up/Shift+Down and Alt+period/Alt+comma effort shortcuts to the interactive composer. An unset selection anchors at the provider-published default; unknown or disagreeing defaults require an explicit `/effort` choice.

Correct the subscription transport's model-specific effort contract. Recognized subscription models no longer offer or accept `none`, and only models whose current catalogue includes `ultra` accept it. Consumers that sent `none` to a recognized subscription model must omit effort or select one of the provider's published levels.
