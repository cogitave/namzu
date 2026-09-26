---
'@namzu/cli': patch
---

Reflow completed conversation text when the terminal expands, preserving the draft and one copy of history. Show when the model picker has more models above or below its visible rows; wider terminals count hidden models. Pause and error messages name the provider that reported a failure when available. A paused turn now tells operators to use `/resume` or `/abandon`, and switching providers keeps dependent prompts held until the turn is successfully resumed.
