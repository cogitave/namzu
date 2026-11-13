---
type: Reference
title: Reasoning pace - the per-step cap and the stall monitor
description: How a turn bounds reasoning that piles up without any change - the per-step cap, the stall monitor's nudge and forced action step, the retry for a reply of thinking only, and the settings that tune or remove each.
resource: packages/sdk/src/runtime/query/turn/stall-monitor.ts
tags: [sdk, reasoning, turn]
status: stable
generated:
  by: claude/sonnet-5.5
  at: 2026-11-08
---

# Reasoning pace

A model at high effort can spend a whole step, or many steps, thinking about a change it never makes. Each guard here judges what the turn did, not what the model says it will do. All of them are on by default and set by `TurnConfig.reasoning`.

## The per-step cap

A step that streams more reasoning than the cap before it has begun a tool call is stopped. The request is aborted with a `StepStopped` reason (`provider/step-stopped.ts`), which a provider wrapper can tell from a caller's Stop and must not retry or fail over from, and the step ends with what it produced so far. The model is then told its thinking reached the limit and the next step is an action step.

- The default is 24,000 tokens at medium, high, xhigh and max effort. Lower effort, or none, has no cap.
- `reasoning.maxTokens` sets it, in tokens; `0` removes it. The CLI's `limits.maxReasoningTokens` sets the same value ([Turn limits](../cli/turn-limits.md)).
- It applies to a step that offers tools. It stops applying after three capped steps in a row, so a model that cannot act within the allowance still gets to finish, and it never applies to the closing request a limit makes.

## The action step

A step the loop forces to act (after a capped step, or after the stall monitor) requires a tool call and, where the step's model offers it, runs at low effort for that step only. Effort is refused, not clamped, so low is used only when the model's menu lists it. The effort is the one the step would have used for the model serving it, so a refusal fallback model keeps its own clamped level.

A provider that refuses a forced tool choice (Anthropic's Opus 5.5, Fable 5.1 and Mythos 5.1 and any request with manual extended thinking; DeepSeek with thinking on, which is its default; the Zen Go models whose route takes only `auto`) is not sent one. The kernel asks `LLMProvider.acceptsForcedToolChoiceFor(model, thinking, effort)`, where `effort` is the level the step will carry (the action step's low level included), for a driver where the level also decides whether thinking is on; when the answer is `false`, the step keeps low effort, sends no `toolChoice: 'required'`, and carries one more instruction in words (this reply must be a tool call) on that request only. A provider that does not declare the method is taken to accept, and a fallback chain accepts only if every member does. Before this, a stalled run on such a model failed the turn with `forced_tool_choice_unsupported`, and on a DeepSeek thinking model the vendor's own HTTP 400 ("Thinking mode does not support this tool_choice") ended every subagent that stalled. The DeepSeek driver now refuses a forced choice before transport while thinking is on, with that code, and never sends `auto` in its place; `auto` and `none` are sent as before, and a forced choice goes out when thinking is off (`thinking: { type: 'disabled' }` or effort `none`). The vendor's chat completion reference says `required` and a named function are not supported in thinking mode.

## The stall monitor

The monitor counts consecutive steps that changed nothing. A step changed something when a call in it succeeded and was not read-only; a failed call, a read-only call and any task-list call changed nothing, because keeping a list is not progress on the task.

- After 12 such steps, or 80,000 characters of reasoning across them, the model gets one nudge as a runtime-context message of kind `progress-nudge`.
- After the nudge, 5 more steps without a change make the next step an action step.
- Any change resets the count.

`reasoning.stall` takes `nudgeAfterSteps`, `nudgeAfterReasoningChars` and `forceAfterSteps`, or `false` to turn the monitor off.

## A reply of thinking only

A reply that holds reasoning but no text and no call is not an end. The model is asked once more, plainly, before the closing request a limit makes. If even that produces nothing, the turn ends with a plain error that says the model stopped after thinking and that saying "continue" picks the work up. It never ends silently.

## Related

* [Completion audit](completion-audit.md): the reminder a turn gets when it ends after changing files without a check.
* [OpenAI reasoning effort](openai-reasoning.md#effort-none-on-a-compatible-endpoint): sending effort `none` on a compatible endpoint.
