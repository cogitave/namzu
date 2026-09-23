---
"@namzu/cli": patch
---

An `Agent` call that names the session's own `model`, with no `provider` or `effort`, now runs on the session's provider, as a call with no `model` does. It used to be looked up in the model catalogue, and when the session provider's listing failed or did not list that id, the child ran on any other connected provider that did — including a read-only `explore` launch, which starts without the "Start an agent" review on the promise that it stays on the session's provider. To send a child to another provider, name `provider` (still reviewed).

The agent cockpit's phase pane is titled `Phases`. It used to read `Phases · 1/2`, the cursor position, above phase rows whose `2/2` means agents done, so a finished two-phase workflow read as one phase of two. Nothing to change on your side.
