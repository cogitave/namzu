---
'@namzu/sdk': minor
'@namzu/cli': patch
---

`ScheduleToolHost.create()` may return an optional `note`, which the `schedule` tool appends to what the model is told about the new job. Existing hosts that return only `{ name }` are unaffected. The CLI uses it to tell the model that no scheduler is installed, so its reply no longer promises a run that cannot happen until you run `namzu schedule install`.
