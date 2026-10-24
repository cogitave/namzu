---
type: Reference
title: The small model for side jobs
description: The smallModel config key, how a side job picks its model, what it is used for (conversation titles, the answer web_fetch extracts), how its tokens are counted, and why it never blocks or fails a turn.
resource: packages/cli/src/integrations/small-model/side-model.ts
tags: [cli, config, models, titles, web]
status: stable
---

# The small model for side jobs

Some work happens beside a conversation and does not need the conversation's
model: naming the conversation, and answering a question about a web page. Both
are short requests, and on a large model they would cost more than the work is
worth. Namzu runs them on a small model.

## Which model

In this order:

1. **`smallModel`** in your user or managed config: `provider/model`
   (for example `anthropic/claude-haiku-4-5`), or a bare model id, which means
   that model at the provider the conversation runs on. A model id that itself
   contains a slash (`meta-llama/llama-3-8b`) is read as a bare id unless its
   first segment is a provider this machine has.
2. **The cheapest priced text model the active provider lists.** The listing is
   the one `/model` offers, filtered by the same rule, and a model is priced from
   its own `inputPrice` and `outputPrice` or, when the listing has none, from the
   in-tree [price catalogue](../sdk/model-prices.md). The cheapest is the lowest
   input plus output price; a tie goes to the larger context window. A model
   whose price nobody states is never chosen, because an unknown price is not a
   free one. Models that cannot stream, take no text, or are not chat models
   (embeddings, speech, image and moderation ids) are skipped. The listing is
   read once per conversation model and bounded to three seconds.
3. **The conversation's own model**, when no model can be priced or the listing
   does not answer.

`smallModel` is accepted only from the user and managed config layers, never from
a project's `namzu.config.json` and never from the environment: it chooses where
conversation text is sent, and a repository must not redirect that.

```yaml
# ~/.namzu/config.yaml
smallModel: anthropic/claude-haiku-4-5
```

## What it runs

| Side job | When | Request |
| --- | --- | --- |
| [Conversation title](#conversation-titles) | After the first message of a conversation | No tools, 60 tokens |
| The answer `web_fetch` extracts ([web tools](../sdk/web-tools.md)) | When a page is fetched with a `prompt` | No tools, 8192 tokens |

The live label of a running background agent is a third side request of the same
kind, but it runs on the agent's own model and is described in
[Delegated work](delegated-work.md).

## It never blocks or fails a turn

A side request is made beside the turn, never in front of it. If it cannot be
made, every caller does what it did before the job existed:

- no credential for the small model's provider, a listing that does not answer, a
  request that errors or is cancelled, an empty reply: the title stays the first
  message, and `web_fetch` returns the page as markdown instead of an answer;
- the turn's token limit has no room for it: the request is not made.

Nothing is shown to the person when a side job fails.

## Its tokens are counted

A side request is spend of the turn it belongs to, so it is charged to that
turn's token ledger, the way a [live label](delegated-work.md) is. A request made
in the turn (the page answer) is admitted against the turn's limit first and
counted with the usage the provider reported. A title is asked at the same time
as the turn's own first request, while the turn's account is busy, so it runs now
and its usage is counted when the turn's request has closed. A session with no
delegation runtime has no ledger to count on and makes no side request.

There is no setting that turns side jobs off. To keep them on a model you
choose, set `smallModel`.

## Conversation titles

`/resume` lists conversations by title. A title taken from the first thing a
person typed reads as a sentence that was never meant to name anything, so after
the first message of a conversation the small model is asked for a name:

- a noun phrase of two to five words in sentence case, led by the most specific
  thing the message names (a file, component, issue number or error), keeping
  identifiers as written, with no request verbs ("fix", "add", "investigate") and
  no trailing abstract noun ("review", "evaluation");
- written in the language of the message;
- the message is sent as data inside tags, with an instruction not to follow it;
  a message under 10 characters is not named, and one over 2000 is cut to its
  first 1500 characters, a marker, and its end.

Only the first message of a conversation is named, once per launch, and a failed
request lets the next message try again. The title appears at once in the
[terminal title](terminal-design.md#the-terminal-title) and is saved to the
conversation when no turn is holding its log (at the end of the turn, or when the
queue is empty): a `session_updated` record with `titleSource: derived`.

A name a person chose is never replaced. `/rename` writes a named title, which
wins over the generated one whenever it was written; removing the name falls
back to the first message. Desktop lists the same stored title. A conversation
started in Desktop is not named by the model yet.
