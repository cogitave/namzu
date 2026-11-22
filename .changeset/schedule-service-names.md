---
'@namzu/cli': minor
---

A scheduler service can be stopped, started and inspected by name from any shell. `namzu schedule service install --name <name>` now records the service and the home it serves in `~/.namzu/schedule/services.json`, and `namzu schedule service status|start|stop|logs|uninstall <name>` (new optional name) and `--service <name>` on the job commands act on that service's home without setting `NAMZU_HOME`. New: `namzu schedule service list [--json]`. Install now refuses a `--name` that is already recorded for a different home; uninstall the other service or pick another name. Nothing existing changes: without a name every command acts on the current `NAMZU_HOME` as before.
