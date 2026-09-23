---
name: schedule-task
description: How to propose a scheduled job that runs later with nobody watching - choosing its permission set, schedule, time zone and budget, and wording its prompt for an unattended run. Use when the user asks for something to happen on a schedule, every night, every hour, at a time, or while namzu is closed.
invocation: both
metadata:
  namzu-requires-tools: schedule
---

# Scheduling a task

A scheduled job is a prompt that runs later in a folder, in a new
conversation, with **nobody watching**. It cannot ask questions. Anything its
permission set does not allow either waits for the operator (the run parks
and they get a notification) or is refused. Propose one with the `schedule`
tool, `action: "create"`. The operator sees the job as it will run and
chooses Create, Create paused or Cancel; nothing exists until they do.

Ask the user whatever you cannot infer, then propose. Do not create a job
the user did not ask for.

## 1. The permission set (required, no default)

Start from the smallest set that can do the job.

- `preset: "read-only"`: `read`, `glob`, `grep`, `ls` allowed; writing,
  editing, `bash` and web access denied. Unmatched calls are denied.
- `preset: "edit-in-folder"`: as read-only, plus `write` and `edit`; `bash`
  waits for the operator. Unmatched calls park.
- `rules`: extra rules in the config's `[permissions]` vocabulary, applied
  over the preset: a tool name mapped to `allow`, `ask` or `deny`, or to
  patterns, e.g. `{"bash": {"npm test*": "allow", "*": "ask"}}`. Allow the
  exact commands the job needs, not `bash` as a whole.
- `unmatched` (required): what happens to a call no rule covers. `park`
  waits for the operator (the job's later runs are skipped until they
  answer); `deny` refuses it and the run carries on. Prefer `deny` for a
  job that should never need anyone, `park` when a person should decide the
  odd case. Only the operator can choose `allow`, with
  `namzu schedule add --unmatched allow`; the tool refuses it.
- `execution`: `host` (default) or `sandbox`. Choose `sandbox` when the job
  runs commands it did not write itself.
- Web access (`web_fetch`, `web_search`) is off in both presets. Allow it by
  rule only when the task needs it. The tool refuses web access together
  with a shell on the host; deny `bash`, or use `execution: "sandbox"`.
- The operator's own config `deny` rules always apply on top; a job cannot
  widen them.

## 2. When it runs

`when` takes: `every 30m`, `every 2h`, a five-field cron expression
(`0 9 * * 1-5` is 09:00 on weekdays), `@daily`, `at 2026-09-24 09:00`,
`at 09:00`, or `in 2h`. `tz` is an IANA zone (`Europe/Istanbul`); without
it the host's zone is written into the job. Say the schedule back to the
user in words, with the zone, and check it with them. Prefer an off-peak
minute (`7 3 * * *`) to the top of the hour for anything not time-critical.

## 3. Budget

Every run has a token budget and a wall-clock timeout (defaults: 500 000
tokens and 30 minutes, or the operator's `limits`). Set `budget.tokenBudget`,
`budget.timeoutMs` and `budget.maxIterations` lower for small jobs. The
confirmation shows the most it can spend in a day (runs per day times the
token budget); a frequent schedule with a large budget is expensive.

## 4. The prompt: written for nobody watching

The run starts with no memory of this conversation. Its prompt must stand
alone:

- Say what to do, in which files or commands, and what "done" means.
- Say where the result goes: a file to write, or the run's final message
  (the operator reads it in the run's conversation).
- Say what to do when something is missing or fails: stop and report it in
  the final message. Never guess, never retry destructively.
- Name the commands the rules allow, so the run does not wander into calls
  that park or get refused.
- Put no secrets in the prompt. Point to where a credential lives instead.

Example: "Run `npm outdated --json` in this folder. If any dependency is a
major version behind, write the list with current and latest versions to
`reports/outdated.md`, replacing the file. If the command fails, stop and
report its error. Do not install or change anything."

## 5. Propose, then confirm

Call `schedule` with `name` (lowercase, digits, dashes), `prompt`, `when`,
optional `folder` and `tz`, `permissions` and optional `budget`. Tell the
user it will appear for confirmation. Afterwards, `schedule` with
`action: "list"` shows jobs, and the operator manages them with `/schedule`
or `namzu schedule list`. Jobs run only when the scheduler service is
installed (`namzu schedule install`).

## Browser access

A scheduled run can use the browser only when the `schedule` tool's
`permissions` accepts a `browser` field; if it does not, scheduled runs
cannot use the browser. Where it does, grant `browser: { profile, sites }`
with each site origin mapped to `read`, `ask` or `act`; every site not listed
is denied. Grant `act` only to sites the job must change. The operator signs
in first, once, with `namzu browser login <profile>`; a run that meets a
sign-in page or CAPTCHA stops and notifies them.

## If the tool is not here

Without the `schedule` tool (a headless run, or an agent you started), give
the user the command to run themselves, for example:

`namzu schedule add nightly-deps --prompt "…" --when "0 3 * * *" --permissions read-only`
