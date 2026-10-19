---
"@namzu/cli": patch
---

A screenshot (or any image) in a conversation no longer leaves a text-only model stuck. Images are left out of what such a model is sent and come back when you switch to a model that reads them; computer use is offered only on turns whose model can see the screen, and comes back when Auto moves a turn to such a model; under Auto a picture can be attached whatever the session's own model is; a model that refuses an image anyway is retried once without it and remembered. A rejected request no longer tells you to "send it again" or start a new conversation: it points to `/model`.
