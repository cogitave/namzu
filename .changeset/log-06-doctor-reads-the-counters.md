---
'@namzu/sdk': minor
'@namzu/cli': minor
---

`namzu doctor` now reports what the log pipeline did to this process's records: how many never reached the sink, how many had a credential redacted, and how many were shed or truncated by the size caps. It fails — non-zero exit — when records were dropped, and reports `inconclusive` rather than a green row when no sink was installed at all.

New SDK export `getLogCounters(): LogSinkCounters | undefined`. `undefined` means no host claimed the process's log destination, so nothing measured those records; it is deliberately not a zeroed set, which would read as "nothing was dropped, nothing was redacted" about a process where neither was ever checked.

`LogSinkCounters` had five fields incremented on every record and no reader anywhere. It could not have had one: the counters lived on whatever logger `createLogger` built, and `getRootLogger()` resolves per call and built a fresh one each time, so every total died with the expression that produced it. `installProcessSink` now owns one counter set per installed destination and every logger routed through it adds to those totals. A replacement install (`{ replace: true }`) starts at zero rather than carrying the previous destination's counts forward — the numbers describe the sink that is live.

`createLogger` takes an optional second argument, a counter set to share. Omitting it is unchanged behaviour: a host that builds its own logger for one subsystem keeps its own counts unless it asks otherwise.
