---
'@namzu/sdk': patch
---

The model-facing working rules change in four places, and nothing in the public API moves. The rule about keeping the user informed now asks for one line before the first tool call and a one-line update when the model finds something, changes direction or hits a blocker, in place of the earlier "before a batch" wording. The delegation rules open a task list for work of three or more steps (a two-step job needs none) and tell the model to pass what each finished delegated agent found on to the user in its next message. The notice that delivers a finished delegated task (`formatCompletionNotification`) now says the user has not seen the result, and the owned-work entry asks the model to check, before it ends a reply, that every finished result was reported once. A later file-evidence record names `bodyInCall` and `observedFingerprint` as before. A host that pins these texts in its own tests updates the expected strings; nothing else changes.
