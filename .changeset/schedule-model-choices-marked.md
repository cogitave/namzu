---
'@namzu/sdk': patch
'@namzu/cli': patch
---

The `schedule` tool asks the model to leave optional fields (folder, time zone, execution, budget, a visible browser window) unset unless the user asked for them, and the TUI's confirmation of a proposed job marks every such value the model set that differs from what you would get by default, e.g. `Chosen by the model, not the default: time zone America/New_York, not this machine's Europe/Istanbul`.
