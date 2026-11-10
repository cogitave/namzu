---
type: Reference
title: When a model declines to answer
description: What the kernel does when a provider finishes a reply as a refusal or a safety block: the refused reply is dropped from the history, the request is re-run once on another model, and a turn nothing recovered settles refused instead of end_turn.
resource: packages/sdk/src/runtime/query/iteration/index.ts
tags: [sdk, provider, refusal, safety, stop-reason, fallback]
status: stable
generated: { by: process:claude-code, at: 2026-11-03T00:00:00Z }
---

# When a model declines to answer

A provider can finish a reply as a refusal: the model, or a classifier in front of it, declined the request. That arrives as an ordinary finished stream (`finishReason: 'content_filter'`), not as an error, and it is not an empty answer. Re-sending the same history to the same model is refused again, at the full price of the prompt.

## What a driver reports

A driver whose finish was a refusal or a safety block sets `refusal` on the finish chunk and on the response (`StreamChunk.refusal`, `ChatCompletionResponse.refusal`, the `ProviderRefusal` type):

| Field | Meaning |
|---|---|
| `category` | The provider's own classification (for example `cyber`), when it gives one. |
| `explanation` | The provider's own sentence. Show it; do not parse it. |
| `recommendedModel` | A model the provider says can usually serve the request. |

Every field is optional. An empty object means "refused, nothing more is known", which is all most providers can say. The Anthropic driver reads `category`, `explanation` and `recommended_model` from `stop_details` on the final message delta; a field the service sends as `null` is left out. The OpenAI, Codex, DeepSeek, HTTP, OpenRouter, Bedrock, Google and Zen drivers set `refusal: {}` on a content-filter finish.

An empty assistant entry in the history (a refused or interrupted reply with no text, reasoning or call) has no wire form on the Anthropic Messages API. The driver used to serialise its `null` content as the literal text `"null"`; it now leaves the entry out, as the OpenAI driver does. The stored history is untouched.

The same holds on every Chat Completions-shaped wire. An empty reply stays in the history (the model may have produced only reasoning, or been cut off, or answered a denied call with nothing) and the loop goes on to ask again, so the next request would carry it. Those endpoints reject the request with `HTTP 400: Invalid assistant message: content or tool_calls must be set`, and reasoning does not count as content. Two layers keep it out of the request, and neither edits the stored history:

- The loop leaves out an assistant entry with no text, no tool call, no reasoning and no citation, in every request it sends, the closing request after an empty completion included.
- Each driver leaves out an assistant entry that is still empty on its own wire: the OpenAI, DeepSeek, HTTP (OpenAI and Anthropic dialects), OpenRouter and Bedrock drivers, and the Zen chat lane, which also drops a turn that holds reasoning only. The Anthropic Messages, Google and Zen Messages and Responses lanes already did, or replay reasoning on its own.

An entry with tool calls is never dropped, so a tool result, including the plain "not executed" sentence a denied call gets, always follows the call it answers, and the driver sends no empty `tool_calls` array.

## What the turn does

A refused reply never enters the empty-completion retry that asks the model for a closing summary, and it never settles as `end_turn`. The turn recovers at most once of each kind, in this order:

0. **The same request without recorded context.** Only when the host listed keys in `QueryParams.withholdOnRefusal` and the request carried an entry filed under one of them (see `RecordedContextItem`). The step is re-run once with those entries left out of the request; the history is not changed, so a later turn and a restore still hold them. A `model_refusal` event with `outcome: 'withheld'` names `withheldKeys` and, for the `memory` key, `withheldMemoryIds`, the ids of the recalled memories the entries carried, so a host can set them aside. For the rest of the turn the keys are in `PrepareStepContext.withheldKeys`, and `createMemoryRecallStep` adds nothing while `memory` is there. If the retry is refused as well, steps 1 to 3 run as before. A host that remembers the refusal passes `QueryParams.withheldKeys` on later turns to leave the keys out from the first request.
1. **Another model of the same provider.** The provider names it through `LLMProvider.refusalFallbackFor(model, refusal)`: its recommended model when the credential can use it, otherwise its own declared order. For Anthropic a Sonnet refusal goes to Opus of the same generation, Opus goes to Sonnet, and Haiku goes to Sonnet; only a model the account's model list contains is named. The refused reply is left out of the history sent next, the request is re-run on the other model,, and that model is kept for the rest of the turn. The re-run request carries the nearest effort the fallback model offers (the next level down, else the lowest above) when the turn's effort is not one of its levels, as listed by the provider's `reasoningEffortLevelsFor`; the turn's own effort is unchanged for later requests. A `model_refusal` event with `outcome: 'fallback'` names it before the re-run, so a host that owns the session's model can keep it for later turns and say so. A provider without `refusalFallbackFor`, a chain member declared with a model of its own, and `refusalFallback: 'off'` all skip this step.
2. **The same model, once more.** Only when there was no other model and the refused reply had partial text or tool calls. The partial reply stays in the history, each call in it gets an error result saying it did not run, and a short note tells the model the previous response was stopped by a safety classifier and not to produce that content again. `model_refusal` has `outcome: 'retry'`.
3. **Otherwise the turn settles `refused`.** The stop reason is `'refused'` and `lastError` says which model declined, with the provider's explanation when it gave one. `model_refusal` has `outcome: 'declined'`. The refused reply is not stored, so no empty assistant message is ever sent again. The closing step a limit asked for (a token, cost or iteration limit reached) is never moved or retried, and when it is declined the turn keeps that limit as its stop reason; `model_refusal` still reports `declined`.

The refused iteration is still recorded as a step, so its tokens are accounted for. Old history that may have caused the refusal is not searched for the turn that did; that is not attempted.

## Settings

`QueryParams.withholdOnRefusal` (keys, default none) turns step 0 on, and `QueryParams.withheldKeys` starts a turn with keys already left out. `QueryParams.refusalFallback` is `'auto'` (the default) or `'off'`. With `'off'` step 1 is skipped; step 0 is separate. The CLI exposes it as the `refusalFallback` configuration key.

## Events and stop reasons

`model_refusal` carries `model`, `providerId`, `outcome` (`'fallback'`, `'retry'`, `'withheld'` or `'declined'`; a host that switches over it must add `'withheld'`), `fallbackModel` (with `'fallback'`), `withheldKeys` and `withheldMemoryIds` (with `'withheld'`), and `category` and `explanation` when the provider gave them. On the SSE wire it is `model.refusal`.

`StopReason` gains `'refused'`. A host that switches over `StopReason` exhaustively must add a case; one that treats every value other than `end_turn` as "did not finish" already does the right thing.
