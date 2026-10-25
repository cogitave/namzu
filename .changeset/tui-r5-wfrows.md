---
'@namzu/cli': patch
---

A workflow run with a failed agent is counted the same way everywhere (`2/3 agents · 1 failed`): the closing line used to say `3 agents`, and the `/workflows` list lacked the failure. The rail row keeps `1 failed` at narrow widths and drops the time and token spend first. `/hypermode on` and `/hypermode off` no longer say `Effort stays at the model default.` for a model that publishes no effort levels. A headless run (`exec`, `exec --json`) of a conversation that was told hypermode is on now tells the model it is off when it is.
