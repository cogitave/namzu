---
'@namzu/cli': patch
---

A workflow script that could not run now reads `The workflow script stopped with an error.` in the conversation; the line and column, the engine's own message and the rest stay behind ctrl+o, and the model's text is unchanged. A workflow run with a failed agent is counted the same way everywhere (`2/3 agents · 1 failed`): the closing line used to say `3 agents`, and the `/workflows` list lacked the failure. The rail row keeps `1 failed` at narrow widths and drops the time and token spend first. `/hypermode on` and `/hypermode off` no longer say `Effort stays at the model default.` for a model that publishes no effort levels. A headless run (`exec`, `exec --json`) of a conversation that was told hypermode is on now tells the model it is off when it is.
