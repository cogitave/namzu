---
type: Reference
title: Schedules
description: The SDK's schedule time engine and evaluator — spec grammar, cron semantics and the DST rule, catch-up and concurrency decisions — and the schedule and session_loop tools built over host callbacks.
resource: packages/sdk/src/schedules/
tags: [sdk, schedules, cron, tools]
status: stable
generated: { by: process:claude-code, at: 2026-09-23T00:00:00Z }
---

# Schedules

The SDK decides **when** something is due. It does not store jobs, run them, or keep history: a host does that (the CLI's is [Scheduled tasks](../cli/scheduled-tasks.md)). What the SDK exports is pure — `Intl` for time zones, no clock, no I/O, no new dependency — so a server embedding the SDK gets the same semantics as the CLI.

| Export | What it is |
|---|---|
| `parseScheduleSpec(input, { now, tz })` | Schedule words into a validated `ScheduleSpec` |
| `parseCronExpression(expr)` | Five-field cron into sets (`CronExpression`) |
| `nextFireTime(spec, after)`, `previousFireTime(spec, atOrBefore)`, `upcomingFireTimes(spec, after, n)` | Instants a spec fires at |
| `countOccurrences(spec, from, to, cap?)` | How many fire in `(from, to]`, with the first and latest, never enumerated |
| `describeSchedule(spec, { tz })` | The schedule in words |
| `validateTimeZone(tz)`, `hostTimeZone()`, `parseDuration(text)` | Helpers |
| `evaluateJob(input)` | What to do about one job now |
| `buildScheduleTools(host)`, `buildSessionLoopTools(host)` | The `schedule` and `session_loop` tools |
| `scanSchedulePrompt(prompt)`, `revealHiddenCharacters(prompt)` | The prompt tripwire a confirmation screen shows |
| `generateScheduleJobId()`, `generateScheduleRunId()` | UUIDv7 strings for a host's records |
| `SCHEDULE_CATCH_UP_WINDOW_MS` (7 days), `SCHEDULE_LATE_GRACE_MS` (2 minutes) | Defaults |

The unions `ScheduleDecision`, `ScheduleSkipReason` and `ScheduleMissedReason` may grow in a minor release. Switch over them with a `default:` branch.

## Spec grammar

| Input | Spec |
|---|---|
| `at 2026-09-24 09:00`, `at 2026-09-24T09:00`, `at 09:00` (the next one), `in 30m` | `at` — a local time is read in `tz` |
| An ISO instant with `Z` or an offset | `at`, taken as written |
| `every 30m`, `every 2h`, `every 1d`, `every 90m` | `every`, anchored at `now` rounded down to the minute |
| `0 9 * * 1-5`, `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly` | `cron`, carrying `tz` |

Nothing is rounded silently. `every 30s` is refused and names `every 1m`; `every 90s` names `every 1m` and `every 2m`. An `at` in the past, an `at` inside a spring-forward gap, a cron expression with no occurrence in five years (`0 0 30 2 *`), and `L`, `W`, `#`, `?`, a sixth (seconds) field and `@reboot` are all refused; `ScheduleValidationError.token` names what was refused.

`every` is elapsed time in UTC, `anchorAt + k·everyMs` for k ≥ 1, so `every 1d` drifts an hour against the wall clock across a DST change. Use cron for "every day at 09:00".

## Cron semantics

Fields are minute, hour, day of month, month (`jan`–`dec`), day of week (`sun`–`sat`, `0` and `7` both Sunday), with lists, ranges and steps. When both day fields are restricted a day matches if **either** matches (Vixie cron): `0 0 13 * 5` fires on the 13th and on every Friday.

A cron spec is evaluated in its own IANA zone through `Intl.DateTimeFormat`. The walk is a local day at a time; a day with no offset change is computed arithmetically, and only a day whose offset changes is examined slot by slot. That is where the DST rule applies, and it is cronie's:

- **Fixed-time expressions** — minute and hour are single values or lists, with no `*` and no step. A time a spring-forward skips fires once, at the first instant after the gap (`30 2 * * *` in New York fires at 03:00 on that day). A time a fall-back repeats fires once, at the first occurrence.
- **Wildcard or step expressions** (`0 * * * *`, `*/15 * * * *`) fire at every instant whose wall time matches. The repeated hour runs twice and slots inside the gap do not exist.

The golden tables in `packages/sdk/src/schedules/__tests__/next-fire.test.ts` cover UTC, Istanbul (no DST), New York, Lord Howe (a 30-minute shift) and Kathmandu (+05:45).

## The evaluator

```ts
import { evaluateJob, type ScheduleDecision } from '@namzu/sdk'

const decision: ScheduleDecision = evaluateJob({
	job: {
		spec: { kind: 'cron', expr: '0 3 * * *', tz: 'Europe/Istanbul' },
		state: 'active',
		createdAt: '2026-09-01T00:00:00.000Z',
		updatedAt: '2026-09-01T00:00:00.000Z',
		revision: 1,
	},
	state: { lastEvaluatedAt: '2026-09-17T01:00:00.000Z', jobRevision: 1 },
	now: new Date('2026-09-23T10:00:00.000Z'),
	daemon: { startedAt: new Date('2026-09-23T09:59:00.000Z') },
	isClaimed: () => false,
})

for (const skip of decision.skip) {
	switch (skip.reason) {
		case 'paused':
			break
		default:
			console.log(skip.reason, skip.count)
	}
}
if (decision.fire) console.log(decision.fire.trigger, decision.fire.scheduledFor.toISOString())
```

The evaluator is idempotent over `(state, now)`: a host that lost its in-memory queue rebuilds it by evaluating again, and an occurrence the host already claimed (`isClaimed(key)`, the key is the scheduled instant in epoch milliseconds) is never fired twice. The rules, in order:

| Situation | Decision |
|---|---|
| Nothing due in `(lastEvaluatedAt, now]` | nothing |
| `now` is before `lastEvaluatedAt` (the clock went back) | nothing; `lastEvaluatedAt` never moves backwards |
| The job's revision changed since the state was written | counting starts at the change, so an edit never invents catch-ups for times the old schedule owned |
| Job `paused` / `pending-confirmation` | one collapsed `skip paused` / `skip awaiting-confirmation`; a one-shot whose time passed is `expired` |
| Provider quota hold not over | `skip quota-hold` |
| The job's previous run is queued, running or parked | `skip previous-run-active` / `previous-run-awaiting-approval` |
| Latest due occurrence within the late grace (2 min) | fire `scheduled`, or `late` past 5 s; earlier ones are one `missed` record |
| Latest within the catch-up window (7 days) | fire one `catch-up`; everything earlier is one `missed` record |
| Everything older than the window | no run: one `missed` record and `skip beyond-catch-up-window` (`one-shot-expired` and `expired` for an `at`) |

Occurrences are counted, never enumerated, up to 100 000 (`capped` says when the count stopped). A missed reason is best effort: `machine-asleep` or `clock-jumped-forward` when the host observed the gap itself, else `daemon-not-running`.

## The tools

`buildScheduleTools(host: ScheduleToolHost)` returns one tool, `schedule`, with actions `create`, `list`, `update`, `pause`, `resume` and `delete`. The SDK owns the model-facing contract:

- `create` needs `name`, `prompt`, `when` and `permissions`, and `permissions` needs `unmatched` plus a preset or rules. There is no default permission set.
- The tool's description and the `folder`, `tz` and `execution` fields tell the model to leave optional fields unset unless the user asked; the CLI's confirmation marks each one it set anyway (`chosenByTheModel`).
- The tool does not declare `delete` destructive: every `create`, `resume` and `delete` is confirmed on the host's screen before anything changes, and a destructive flag put a second review in front of it. The CLI also exempts those three from the permission review (`reviewExemptionFor`, `confirmsItself`) in every mode but `plan` and `strict`.
- The model can propose `unmatched: 'park'` or `'deny'`, never `'allow'`, and cannot combine `web_fetch`/`web_search` or a browser grant with a shell on the host. A shell is possible when a `bash` rule is not `deny`, or, with no `bash` rule, when `unmatched` is not `deny` — except under the `read-only` preset, which denies `bash`.
- `permissions.browser` (`ScheduleBrowserGrant`: `profile`, `sites` mapping each site to `read`, `ask` or `act`, `headed?`) grants the browser tools on the listed sites only. The tool canonicalises the site keys, refuses `*`, and refuses the block unless the host sets `browserGrants: true`. A preset, rules or a browser grant is required. See [Browser tools](browser-tools.md#the-scheduled-job-grant).
- The host computes the preview (`ScheduleJobPreview`): the canonical folder, the schedule in words, the next fire times, the expanded rules, the budget, the model. The model's words are never shown as fact. The input schema describes `budget` as the limits of one run and `maxIterations` as model steps, not repetitions: a model once proposed `maxIterations: 1` for a job meant to post once per run, and its first run stopped after one model call. `tokenBudget` is described as the whole run's, with every model call resending the prompt; the next proposal set 4 000 tokens for runs that each took about 110 000.
- `host.confirm()` asks the person. Only `create` or `create-paused` creates a job. `cancel`, a thrown error or a closed screen creates nothing. `host.create()` may return a `note` beside the job's name, which the tool appends to what the model is told: the CLI says there when no scheduler is installed, so the model does not report the job as running. `resume` and `delete` confirm through `host.confirmAction()`; `pause` does not.
- `update` changes an existing job in place: `job` names it, and only the fields the model sets (`prompt`, `when`, `folder`, `tz`, `budget`, or `permissions` as the whole new set, under the same limits as `create`) are passed on, as `ScheduleJobChanges`; `name` is refused (a job keeps its name). The host's optional `previewUpdate(job, changes)` computes `ScheduleJobUpdateProposal` — the job as it would run (`preview`), the `-`/`+` lines of what differs (`changes`) and whether what a run may do changes (`permissionsChange`) — or throws with a refusal; `confirmUpdate(request, signal)` asks the person (anything but `true` saves nothing, and an answer after the call was given up is ignored); `update(preview)` saves the change to the same job and may return a `note`. A host without all three gets `update` refused with a message that tells the model not to delete and recreate the job instead. The tool's description says the same: in a live session, asked to change a job, a model deleted it and created it again, and its history went with it.
- `list` asks `host.list({ allFolders })`, `allFolders` being the model's (default `false`), and reports one line per job, `No scheduled jobs.` when there is none. A host may list every job regardless of `allFolders`; `ScheduleJobSummary.inSessionFolder` marks the session folder's, which the tool prints as `(this folder)`. The CLI's host does, because models do not pass `allFolders`: one was told "No scheduled jobs." right after creating a job in a folder below the session's.
- `scanSchedulePrompt` flags invisible characters, "ignore previous instructions", secret files and exfiltration shapes. The findings are shown in the confirmation and never block on their own.
- The tool declares its own `timeoutMs`, thirty minutes, so the executor's two-minute default deadline never cuts a person off mid-read (the same duration `save_skill` uses for the same reason). Both `host.confirm()` and `host.confirmAction()` are given the tool's abort signal; it fires when that deadline elapses or the turn is stopped, and either settles the pending call as `cancel`/`false` and, in a host that draws a screen, closes it — never leaves it on screen after the tool has stopped waiting for the answer.

Register it only where a person can confirm. The CLI registers it in the interactive TUI and never in `exec`, a scheduled run, a sub-agent, a resident worker or ACP.

`buildSessionLoopTools(host: SessionLoopHost)` returns `session_loop` (`create`, `list`, `delete`): re-send a prompt to the same conversation on an interval while the session is open. `create` is an ordinary reviewed call, not review-exempt, so in `prompt` mode the operator sees it first. The CLI's host is described in [Session loops](../cli/session-loops.md).

## The directory loader's three objections

`packages/sdk/src/directory/types.ts` records why `schedules/` was cut from the directory loader. They are answered here, outside the loader:

- *A cron field with no time-zone story*: every cron spec carries an IANA zone, and the DST rule above is explicit.
- *Schedules double-fire, no idempotency key*: every occurrence has a key, the scheduled instant, which a host claims before a run starts (the CLI publishes the claim with `link`, so a second daemon cannot start it again).
- *Signed webhooks*: out of scope. There is no inbound trigger.
