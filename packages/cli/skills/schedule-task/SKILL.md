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
- `execution`: `host` (default) or `sandbox`. Leave it unset unless the
  user asked for a sandbox.
- Web access (`web_fetch`, `web_search`) is off in both presets. Allow it by
  rule only when the task needs it. The tool refuses web or browser access
  together with a shell on the host (`read-only` already denies `bash`);
  deny `bash`, or use `execution: "sandbox"` if the user asked for one.
- `browser`: see [Browser access](#browser-access). A browser job usually
  needs nothing more than `preset: "read-only"` plus the grant.
- The operator's own config `deny` rules always apply on top; a job cannot
  widen them.

## 2. When it runs

`when` takes: `every 30m`, `every 2h`, a five-field cron expression
(`0 9 * * 1-5` is 09:00 on weekdays), `@daily`, `at 2026-09-24 09:00`,
`at 09:00`, or `in 2h`. Leave `tz` unset unless the user named a zone: the
operator's own zone is written into the job, and a zone you choose is
marked on the confirmation as the model's choice. Say the schedule back to
the user in words, with the zone, and check it with them. Prefer an off-peak
minute (`7 3 * * *`) to the top of the hour for anything not time-critical.

## 3. Budget

`budget` is the limits of ONE run, not of the job. Leave it unset unless
the user asked for limits: the defaults are 500 000 tokens and 30 minutes a
run (or the operator's `limits`). If you set it:

- `tokenBudget` is every token the run spends. Each model call resends the
  whole prompt (often 10 000 to 30 000 tokens), so a run needs far more
  than its answer; the confirmation warns below 50 000.
- `maxIterations` is model steps in one run (each model call with its tool
  calls), not how many times the job runs. A browser task takes 10 or more.
- `timeoutMs` is one run's wall clock.

The confirmation shows the most the job can spend in a day (runs per day
times the token budget).

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
- Write it in the language the user writes to you in, not in English by
  default: the run answers in the prompt's language, and its summary is what
  the user reads afterwards. Keep exact values (addresses, commands, text to
  post) as the user gave them.

Example: "Run `npm outdated --json` in this folder. If any dependency is a
major version behind, write the list with current and latest versions to
`reports/outdated.md`, replacing the file. If the command fails, stop and
report its error. Do not install or change anything."

## 5. Propose, then confirm

Call `schedule` with `name` (lowercase, digits, dashes), `prompt`, `when`
and `permissions`. Leave `folder` (the session's folder), `tz`, `execution`,
`budget` and `headed` unset unless the user asked for them. The operator
sees one confirmation screen with the job as it will run, and every value
you set that differs from the default is marked as yours. Do not ask them
to confirm again in chat. Afterwards, `schedule` with
`action: "list"` shows every job, in any folder, and the operator manages
them with `/schedule` or `namzu schedule list`.

To change a job, call `schedule` with `action: "update"`, `job` (its name)
and only the fields that change (`prompt`, `when`, `folder`, `tz`, `budget`,
or `permissions` as the whole new set). The operator sees what changes and
confirms it; the job keeps its history. Never delete a job and create it
again to change it: its history is lost. Jobs run only when the scheduler service is
installed: if the result says none is installed, tell the user to run
`namzu schedule install`; do not say the job is set up and running.

## Browser access

Grant the browser with `permissions.browser`:
`{ "profile": "social", "sites": { "http://localhost:8123": "act" } }`.

- `profile` is one the operator already signed in to with
  `namzu browser login <profile> <url>`. Use the one the user named, or ask;
  never invent one. If they have not signed in, tell them the command first.
- `sites` maps each origin the job may open to `read` (open and read only),
  `ask` (changes wait for the operator; needs `unmatched: "park"`) or `act`
  (changes run unasked). Every site not listed is denied; there is no
  `*`. Grant `act` only to sites the job must change.
- `headed: true` shows a window; leave it unset (no window) unless asked.
- A run that meets a sign-in page or a CAPTCHA stops and notifies the
  operator (`needs you: …`); they sign in again and continue it with
  `namzu resume`.
- In the prompt, name the site's address and what to do there, step by
  step, as for a person who has never seen the page.

## If the tool is not here

Without the `schedule` tool (a headless run, or an agent you started), give
the user the command to run themselves, for example:

`namzu schedule add nightly-deps --prompt "…" --when "0 3 * * *" --permissions read-only`

and for a browser job

`namzu schedule add morning-post --prompt "…" --when "0 9 * * *" --permissions read-only --unmatched deny --browser social --browser-site http://localhost:8123=act`
