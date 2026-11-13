---
'@namzu/deepseek': minor
'@namzu/sdk': patch
'@namzu/zen': patch
---

On a DeepSeek thinking model (thinking is on unless you turn it off), a subagent that stalled was sent a forced tool choice and died with `deepseek (HTTP 400): Thinking mode does not support this tool_choice`; four explorers failed that way in one session. Now the step that must act goes in words instead and the run carries on. `DeepSeekProvider` gains `acceptsForcedToolChoiceFor(model, thinking, effort)` (false while thinking is on) and refuses `toolChoice: 'required'` or a named function before sending anything, with a `bad_request` `ProviderRequestError` whose `providerCode` is `forced_tool_choice_unsupported`; `auto` and `none` are sent as before. In `@namzu/sdk` the optional `LLMProvider.acceptsForcedToolChoiceFor` takes the effort the step will carry as a third argument, and the retry, idle-timeout and fallback wrappers forward it; existing implementations that take two arguments keep working. `@namzu/zen` answers it for the Go models whose route takes only `auto`, so those no longer fail the step either.
