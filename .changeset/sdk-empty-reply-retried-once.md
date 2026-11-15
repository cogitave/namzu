---
'@namzu/sdk': patch
---

A reply from the model with nothing in it (no text, no thinking, no tool call, finish reason `stop`) is now asked for once more with the same request instead of ending the turn with nothing shown. A reply cut at the output limit is not asked again. If the second reply is empty too, the turn ends with a message saying so, and the tokens and cost of both attempts count in the turn.
