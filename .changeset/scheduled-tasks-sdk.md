---
'@namzu/sdk': minor
---

Add a schedule time engine and evaluator, and the `schedule` and `session_loop` tools.

New exports, all additive: `parseScheduleSpec`, `parseCronExpression`, `nextFireTime`, `previousFireTime`, `upcomingFireTimes`, `countOccurrences`, `describeSchedule`, `validateTimeZone`, `hostTimeZone`, `parseDuration`, `evaluateJob`, `ScheduleValidationError`, `SCHEDULE_CATCH_UP_WINDOW_MS`, `SCHEDULE_LATE_GRACE_MS`, `buildScheduleTools`, `buildSessionLoopTools`, `scanSchedulePrompt`, `revealHiddenCharacters`, `SCHEDULE_TOOL_NAME`, `SESSION_LOOP_TOOL_NAME`, `generateScheduleJobId`, `generateScheduleRunId`, and the types in their signatures (`ScheduleSpec` and its three variants, `CronExpression`, `ScheduleEvaluationInput`, `ScheduleDecision`, `ScheduleSkipReason`, `ScheduleMissedReason`, `ScheduleToolHost`, `ScheduleJobDraft`, `ScheduleJobPreview`, `SessionLoopHost`, `SessionLoop` and their neighbours).

Everything here is pure: `Intl` for time zones, no clock, no I/O, no new dependency. Cron follows cronie's DST rule (a fixed-time job fires once across a change; a wildcard job fires at every matching instant). Nothing existing changes. `ScheduleDecision`, `ScheduleSkipReason` and `ScheduleMissedReason` may gain members in a later minor release, so switch over them with a `default:` branch. See `docs/sdk/schedules.md`.
