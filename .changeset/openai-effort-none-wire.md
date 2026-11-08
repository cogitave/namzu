---
"@namzu/openai": minor
---

A call for no reasoning now turns reasoning off on a compatible endpoint that has its own switch for it.

`OpenAIConfig.thinkingOffFields` takes request fields (or a function of the model id that returns them) that are sent only on a call with `effort: 'none'` or disabled thinking, and reasoning that still arrives on such a call is dropped from the stream. Left unset, nothing changes: `reasoning_effort` goes out alone as before.
