---
"@namzu/sdk": patch
---

Preserve a fork skill's requested reasoning effort when it has no explicit model. The skill tool now forwards effort independently through the host's existing Agent dispatch instead of silently dropping it. Hosts validate that request: a host requiring a model (including the CLI) returns its refusal, so set a concrete supported model alongside effort there. No model or provider is inferred, and inline skills do not switch the current turn's model or effort.
