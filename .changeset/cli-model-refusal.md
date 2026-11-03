---
"@namzu/cli": minor
---

When a model declines to answer a message, the terminal now says so in plain words and does something about it, instead of ending the turn as a finished reply with nothing in it. The row names the model that declined (`<model> declined to answer this message. This sometimes happens with safe, normal requests.`), shows the provider's category and sentence on a `Details:` line when it gave them (in place; a long sentence folds and Ctrl+O shows it whole), and then either names the model that answered instead (`/model` switches back) or says how to edit the message or pick another model. The refused reply is no longer sent again on the next turn.

New behaviour on a refusal: with an Anthropic model, the message is re-run once on another model of the same provider, which can be a larger and costlier one (Sonnet to Opus, Opus to Sonnet, Haiku to Sonnet, or the model the service recommends, only if your account can use it), and the conversation keeps that model until you switch with `/model`. To keep the model unchanged, set `refusalFallback: off` in your configuration file; the message is then retried once on the same model only if the refused reply had partial output, and otherwise ends with the plain row. Other providers never swap models on a refusal; they report it and stop.

What breaks: a turn a model declined now ends with the stop reason `refused` and `namzu exec` exits 1 with `The model declined to answer this message.` on stderr, where it used to exit 0 with an empty reply. A script that treated an empty exit-0 reply as an answer will now see the failure; one that already handled a non-zero exit needs no change. `namzu exec --json` carries a new `model-refusal` event and the `refused` stop reason. The new configuration key `refusalFallback` accepts `auto` (the default) or `off`; any other value is refused at startup.

The "answered instead" row and the switch to the other model now require that the other model actually produced a reply (text or a tool call). A limit stop (step limit, budget) right after the retry, before it answered, shows nothing and keeps the conversation's model.
