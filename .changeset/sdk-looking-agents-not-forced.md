---
'@namzu/sdk': major
---

An explore sub-agent (one whose every tool only reads) is no longer told to "make the first edit" after twelve looks: each new read counts as progress, and when it only repeats itself it is told to report what it found and what is still unknown.

Breaking, a changed default: the kernel's guards (the stall monitor and the per-step reasoning cap) used to send `toolChoice: 'required'` for their action step whenever the provider did not say otherwise. A provider that does not implement `LLMProvider.acceptsForcedToolChoiceFor` (the HTTP and OpenAI drivers, custom drivers) was taken to accept it; it now gets the instruction in words (`FORCED_STEP_MESSAGE`) and no `toolChoice`. The same holds when thinking is on for the request, and for a `withProviderFallback` chain, which answers `true` only if every member declares the method and answers `true` (a member that does not declare it used to count as yes and now counts as no). To keep the old behaviour, implement `acceptsForcedToolChoiceFor` on the driver and answer `true` for the models that take a forced choice, and run those requests with thinking off (`thinking: { type: 'disabled' }`). A host's own `step.toolChoice` is passed through unchanged. No exported symbol changes.
