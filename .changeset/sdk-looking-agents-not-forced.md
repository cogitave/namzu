---
'@namzu/sdk': patch
---

An explore sub-agent (one whose every tool only reads) is no longer told to "make the first edit" after twelve looks: each new read counts as progress, and when it only repeats itself it is told to report what it found and what is still unknown. The kernel's guards (the stall monitor and the per-step reasoning cap) also no longer force a tool call by protocol unless the provider says a forced choice is safe and thinking is off; they ask in words instead. No exported symbol changes. One documented default changes in effect: a provider that does not implement `acceptsForcedToolChoiceFor` (the HTTP and OpenAI drivers, custom drivers) used to be taken to accept `tool_choice: "required"` from a guard and now gets the instruction in words; a driver that wants the old behaviour implements `acceptsForcedToolChoiceFor` and answers `true` (and the request must have thinking off). A host's own `step.toolChoice` is passed through unchanged.
