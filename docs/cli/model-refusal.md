---
type: Reference
title: When a model declines to answer in the CLI
description: What the terminal, namzu exec and restored transcripts say when a model declines a message, how the request is re-run once on another model and that model kept for the conversation, and the refusalFallback key that turns the swap off.
resource: packages/cli/src/tui/model-refusal.ts
tags: [cli, provider, refusal, safety, config]
status: stable
generated: { by: process:claude-code, at: 2026-11-03T00:00:00Z }
---

# When a model declines to answer in the CLI

A provider can decline a message: the model, or a safety classifier in front of it, says no, and the reply comes back finished but empty. The kernel's side of this (the refused reply is kept out of what is sent next, one automatic retry, the `refused` stop reason) is in [When a model declines to answer](../sdk/model-refusal.md). This page is what the CLI does with it.

## What the terminal shows

One plain row, with no ids and no instruction to start over:

- When another model answered: `<model> declined to answer this message. This sometimes happens with safe, normal requests. <other model> answered instead; /model switches back.` The partial text the first model had written is withdrawn from the transcript.
- When nothing answered: `<model> declined to answer this message. This sometimes happens with safe, normal requests. Press esc twice to edit your message, or pick another model with /model.` The turn then ends as stopped, not as a finished reply: no "done" closing line, and the notification says stopped.
- When the request carried recalled memories and was retried without them: `Retried without the memories this request carried; they are set aside in /memory.` This comes before any other model is tried; see [Memory](memory.md#memory-that-goes-unused-and-memory-a-refusal-set-aside).
- When the model stopped part-way and the same model is tried once more with that noted: `<model> stopped its reply to this message. ... Trying once more with that noted.`

If the provider said why, a `Details:` line under the row carries its category and its sentence. It is shown in place, not behind a separate control; a long sentence (over 240 characters, kept to 600) folds like any long detail, and Ctrl+O shows it whole. A restored conversation that holds a refused turn shows the second wording without the model name. A content-filter error a provider returns instead of a finished reply uses the same words.

## The model is kept for the conversation

When another model answers, the row above appears and the conversation switches to it when the turn settles, the way a model-requested switch does, and says `Switched to <provider> · <model> for this conversation.` `/model` switches back. The row and the switch happen only if the other model actually produced a reply (text or a tool call): a limit stop such as the step limit or the budget right after the retry, before it answered, shows nothing and keeps the conversation's model. Under Auto nothing is pinned: the row says `Auto will choose a model again for your next message.` instead of offering `/model`. If the other model cannot be selected for the conversation, the screen says `<model> answered this message but could not be kept as the selected model.` A `/model` pick made while the reply is still running is held until it finishes, because the other model is in use until then. A pick made after the refusal wins over the switch to the other model; one made before it named the model that declined and is dropped (`<model> declined this message, so <other model> stays selected.`). The other model is sent the nearest effort it offers (the next level down) when the conversation's effort is not one of its levels, for that reply only. If the other model declines too, no row claims an answer, the second wording names that model, and the conversation keeps the model it had. The switch uses only a model the account can use: the provider names it from the model list it can read, and names none when it cannot read one.

## `refusalFallback`

```yaml
refusalFallback: off
```

`auto` (the default) re-runs a refused message once on another model of the same provider. `off` never changes the model: the message is retried once on the same model only when the refused reply had partial output, and otherwise ends with the plain row above. Set it in the user, project or managed file; no environment variable sets it, because it decides which model receives a conversation.

## `namzu exec`

A model that answered in another model's place is reported on stderr in the same words. A turn nothing recovered prints nothing on stdout, writes `The model declined to answer this message. This sometimes happens with safe, normal requests. Rephrase the request, or run it on another model.` to stderr, and exits 1, as for any turn that did not finish. `--json` carries the same facts as a `model-refusal` event and the `refused` stop reason.
