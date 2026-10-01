---
"@namzu/cli": minor
---

Expose the selected model's exact reasoning effort choices and per-message tool permissions to the desktop operator. Read installed plugin metadata without starting a model session or executing plugin modules; plugin changes remain scoped to an existing idle conversation.

Add scoped desktop-host methods for reasoning settings and plugin inventory. Explicit plugin enable/disable choices remain local to the conversation and are restored when changing its model; they do not update startup configuration.

Agent sessions expose optional image/document attachment support declarations from their exact primary provider route. ACP rejects new attachments before a model request when that route explicitly cannot receive them; undeclared support retains the existing runtime policy.
