---
type: Guide
title: Scheduled tasks
description: Prompts that run later in a folder while namzu is closed — creating and confirming jobs, the required permission set, what one run is, approvals, missed runs, notifications, history and the limits of the design.
resource: packages/cli/src/schedule/
tags: [cli, schedule, automation, permissions]
status: stable
generated: { by: process:claude-code, at: 2026-09-23T00:00:00Z }
---

# Scheduled tasks

A scheduled job is a prompt that runs later, in a folder, while namzu is closed:
every night at 03:00, every 30 minutes, once tomorrow at 09:00. Each run is its
own conversation you can `/resume`, a desktop notification, and a line in the
job's history. A job runs under a permission set you wrote down when you created
it, and a call that set does not allow **waits for you or is refused — it is
never approved on its own**.

Jobs are run by one small scheduler process per `NAMZU_HOME`, installed once as a
user service. [The scheduler service](scheduler-service.md) covers installing it
on Linux, macOS, Windows and WSL.

```sh
namzu schedule install
namzu schedule add nightly-deps \
  --prompt "Check for outdated dependencies and summarise what changed." \
  --when "0 3 * * *" --permissions read-only
namzu schedule list
```

## Creating a job

`namzu schedule add <name>` needs a prompt, a schedule and a permission set;
there is no default permission set.

| Option | Meaning |
|---|---|
| `--prompt <text>` / `--prompt-file <file>` | What each run is asked to do |
| `--when <spec>` | `every 30m`, `every 2h`, `0 9 * * 1-5` (cron), `@daily`, `at 2026-09-24 09:00`, `at 09:00`, `in 2h` |
| `--permissions <preset \| file.json>` | `read-only`, `edit-in-folder`, or a JSON file (below). Required |
| `--folder <dir>` | Where the run works. Default: this directory |
| `--unmatched park\|deny\|allow` | A call no rule covers: wait for you, refuse, or run |
| `--execution host\|sandbox` | Where commands run. Default `host` |
| `--tz <zone>` | IANA zone for cron and local times. Default: this machine's, written into the job |
| `--model <provider>/<model>` | Pinned at creation. Default: your configured primary |
| `--token-budget <n>`, `--max-iterations <n>`, `--timeout 30m` | Per run. A token budget and a timeout are always set (defaults 500 000 tokens, 30 minutes, or your `limits`) |
| `--wait-for-provider 10m` | How long a run waits out a provider pause before giving up |
| `--approval-ttl 7d` | How long a parked run waits for you before it is abandoned |
| `--keep-sessions 20` | Completed-run sessions kept visible before older ones are archived |
| `--pause-after-failures 5` | Failed runs in a row before the job pauses itself (0: never) |
| `--add-dir <dir>` | Another directory the file tools may reach |
| `--notify-summary` | Put the run's one-line summary in its notification |
| `--paused` | Create it paused |
| `--yes` | Do not ask. Without a terminal this creates the job **inert** (below) |
| `--allow-unattended-host` | Required for `--unmatched allow` with host execution |

Before anything is written, `add` shows the job as it will run: the canonical
folder, the schedule in words with the next three times in the job's zone, the
model, the budget with the most tokens it can spend in a day (runs per day ×
token budget), whether it can reach the network, and every rule in force —
including the denies it inherits from your config files. On a terminal it asks
you to confirm.

### Only a terminal or the TUI confirms a job

A job is confirmed on a terminal (`add`, `edit`, `confirm`) or in the TUI's
`/schedule` panel. **Without a terminal nothing is confirmed**: `--yes` from a
script — or from a model's own shell call — writes the job inert
(`awaiting confirmation`), and the scheduler never runs it until someone runs
`namzu schedule confirm <name>` on a terminal or confirms it in the TUI.

The confirmation records a digest of what was confirmed: the prompt, the folder
and its trust, the permissions, the schedule, the model, the budget, and a
digest of the project's code-running config (below). If the job file is later
edited by anything but the CLI, the scheduler puts it on hold, records `job
tampered` in its history and notifies you once. Confirming a job also trusts its
folder **for that job only**; your `trust.json` is not touched.

These are tripwires, not a lock. "A terminal" means standard input and error
are terminals, which any program running as you can arrange (`script` gives it
one), and the digest is a plain hash that such a program can recompute after
writing a job file itself. They stop a job appearing from a script's or a
model's ordinary shell call, and an edit that forgets the digest; they do not
stop a program running under your account that sets out to get past them.
What holds against a scheduled run is its permission set: nothing it asks
beyond its rules is approved without you. The floor below, which refuses the
scheduler's commands and paths into `NAMZU_HOME`, is a pattern check on the
same footing as these tripwires: it catches the ordinary ways of writing them,
not every way. A job whose rules allow `bash` without asking, or that uses
`unmatched: allow`, can reach whatever your account can if the model sets out
to; give such a job `execution: sandbox`, or keep `bash` on `ask`.

A folder may not be `/`, your home directory itself, a folder that contains
`NAMZU_HOME`, or anything inside `NAMZU_HOME`.

## What a run may do

Presets are expanded when the job is created and stored as rules, so a later
change to what a preset means never changes an existing job.

| Preset | Rules | Anything else |
|---|---|---|
| `read-only` | `read`, `glob`, `grep`, `ls` allowed; `write`, `edit`, `bash`, `web_fetch`, `web_search` denied | denied |
| `edit-in-folder` | as `read-only`, plus `write` and `edit` allowed and `bash` waits for you | waits for you |

Neither preset reaches the network. A permission file adds rules in the
`[permissions]` vocabulary of your config:

```json
{
  "preset": "edit-in-folder",
  "rules": { "bash": { "npm test*": "allow", "npm run lint*": "allow", "*": "ask" } },
  "unmatched": "park",
  "execution": "host"
}
```

The rules a run is gated by, in order (the first that matches decides):

1. the dangerous-command floor (`rm -rf /`, `mkfs`, `curl … | sh`, `sudo` …):
   **refused**, always. It never waits for you — an approval cannot open it;
2. the scheduled-run floor (`packages/cli/src/schedule/floor.ts`), which
   refuses a call that reaches the scheduler or `NAMZU_HOME`. It is one
   `predicate` rule, and it decides a `bash` command line on the words bash
   will pass, as the SDK's lexer reads them ([How command lines are
   read](../sdk/command-lines.md)): quotes removed, `$'…'` decoded, line
   continuations joined, each simple command on its own, the payload of a
   nested `bash -c` or `sh -c`, every redirection target, and the words of
   `for` lists and `case` statements. Quoting is not what it matches, so
   `n$'\x61'mzu "sch"edule re\` then `move x` on the next line is
   `namzu schedule remove x`, and `echo 'namzu schedule remove x'` is `echo`
   with one argument. It refuses:
   - **the scheduler's own commands**, wherever they stand in a command, so
     `sudo`, `env`, `nohup` or `timeout` in front changes nothing:
     `systemctl` with `stop`, `disable`, `mask`, `edit`, `kill`, `revert`,
     `freeze`, `set-property` or `clean` and a unit naming namzu or a glob
     (`'namzu*'`), `systemctl isolate` and `exit`; `launchctl` with
     `bootout`, `unload`, `remove`, `disable`, `kill` or `stop` and a namzu
     label; `schtasks` with `/Delete`, `/Change` or `/End` (or `-delete` …)
     and a namzu task, in any order; `pkill` or `killall` with a pattern that
     could match the daemon (`node`, anything naming namzu, a regular
     expression, and under `-f` anything in the daemon's command line);
     `busctl`, `dbus-send` or `gdbus` naming namzu; and every `namzu
     schedule` subcommand except `list`, `show`, `status`, `history` and
     `logs`, however the CLI is reached (`namzu`, a path to it, `npx
     @namzu/cli`, `node …/bin.js`, `node`, `npx`, `bun` …), with options
     between. A word that expands at runtime (`$VERB`, `"$ARGS"`) counts as
     any word there, so `namzu schedule "$VERB"` and `namzu $ARGS` are
     refused;
   - **anything that resolves into `NAMZU_HOME`**: a word or redirection
     target whose path is inside it once `~` (where bash expands it: not
     `'~'/x` or `~"/x"`), `$HOME`, `${HOME}`, `$NAMZU_HOME`, `$PWD` and the
     variables the line assigns are spelled out and `.` and `..` resolved,
     anywhere in the word (`--config=/home/you/.namzu/x`), in any letter case
     (macOS and a Windows drive read `~/.NAMZU` as `~/.namzu`). A relative
     path is resolved against the job's folder and every directory a `cd` or
     `pushd` before it names (`cd ~ && rm -rf .namzu`; in a loop, every `cd`
     in the line). A word with an unknown variable or a glob in it is refused
     when what comes before the unknown part could lead into `NAMZU_HOME`
     (`~/.nam*`, `~/$X`, `/$X`), or what comes after it names `NAMZU_HOME`'s
     last segment (`$X/.namzu/…`). A glob does not match a leading dot, so
     `ls ~/*` is not refused. An assignment standing alone (`D=~/.namzu`)
     reaches no program and is judged where `$D` is used; one passed to a
     command or exported is judged where it stands;
   - **what the lexer cannot account for, when it mentions what the floor
     protects.** A line is opaque when it holds a command substitution, a
     function, `[[ … ]]`, arithmetic on a variable, a syntax error or another
     construct listed under [When a line is
     opaque](../sdk/command-lines.md#when-a-line-is-opaque). A command also
     escapes the reading when its name expands (`$S --user stop …`) or when it
     runs text as code: a shell the lexer did not follow (`bash` reading its
     input or a script, `sudo bash -c`, `env -S`), `eval`, `source`, `.`,
     `xargs`, `watch`, `ssh`, `su`, `python`, `node`, `perl`, `ruby`, `awk`,
     `sed` and the like. Such a line is refused when its text, with quotes
     and backslashes dropped, or any decoded word names `namzu`, `schedul`,
     `systemctl`, `launchctl`, `schtasks`, `pkill`, `killall`, `busctl`,
     `dbus-send`, `gdbus`, `NAMZU_HOME` or its last segment, or a path into
     it. Text such a program may run — an argument, a here-string, a
     here-document's body — is read as a command line of its own, so
     `echo $'…\x6e…' | sh` is refused when its decoded text would be;
     otherwise it is not: `echo "$(date)" >> run.log` runs.

   Every other tool's arguments are read as text, at any depth: a string
   naming `NAMZU_HOME` by path, as `~/…`, `$HOME/…` or `${HOME}/…`, or as
   `$NAMZU_HOME`, in any letter case, is refused, and so is one that would
   once a shell dropped its quotes and backslashes (`~/.nam"z"u`).

   The floor reads a line, not the programs it starts: a script file, a
   `Makefile` target, an npm script or a git hook the run wrote earlier is
   not read, nor is a variable the environment already holds (`cd "$DIR"`
   then a relative path), `CDPATH`, or a symbolic link. Those rest on the
   folder rule and the hold above. The floor's reading was checked against
   bash 5.3: 75 000 generated lines mixing the scheduler's commands,
   `NAMZU_HOME` paths and look-alikes in every quoting form, nested
   `bash -c`, pipes into `sh`, here-documents, loops, `cd` and variables,
   each run in a sandboxed bash that recorded every command's arguments, its
   working directory and the files its descriptors opened. Every line whose
   run reached the scheduler or `NAMZU_HOME` (24 343 of them) was refused. Of
   the lines whose run reached neither, 10% were refused by the rules above
   for a value the floor cannot know (an unset variable that could name
   `NAMZU_HOME`, an exported assignment, a redirection into `NAMZU_HOME` that
   fails before its command runs) and 26% more by the tripwire, which the
   generator provokes on purpose; read in the `sh` dialect, where every
   bash-only construct is opaque, the tripwire refused 63% more. None of 158
   ordinary job command lines (builds, tests, git, `find`, loops over files,
   reads under `~`) was refused;
3. every `deny` in your user, project and managed config files, each file read
   on its own. **Allows come only from the job**: a config `allow` never widens
   a job, and a config `deny` ("we never force-push") always holds;
4. the job's own rules;
5. `unmatched`: `park` holds the call for you, `deny` refuses it, `allow` runs
   it. Even under `allow`, a path outside the folder and a sandbox escape wait
   for you.

The project's `namzu.config.json` is repository content: a `git pull` in one run
could add a hook, a tool server, a plugin or a permission before the next. The
sections that run code or change what may run (`hooks`, `mcpServers`,
`plugins`, `permissions`, `permissionChecks`, `sandbox`, `web`,
`additionalDirectories`, `profiles`), the project's `.namzu/commands/` and
`.namzu/plugins/` are pinned when you confirm. If they change, the next run
stops before the model with `blocked-config: project config changed since the
job was confirmed`, and runs again once you confirm the job.

## One run

The scheduler starts each run as its own process, `namzu schedule __fire`, in
the job's folder, with a new conversation titled `⏲ <job> · <time>`. Before the
model is called — zero tokens spent — a run checks that the job is still the
one confirmed, the folder is still the canonical folder it trusted, the
project config matches its pin, every rule compiles, and the pinned provider
has a credential **as the service sees it**. Any failure is `blocked-config`
with the reason.

The run's system prompt tells the model it is unattended: no questions
(`ask_user_question` is not offered), calls outside its rules wait or are
refused, and background jobs end with the run.

A run ends as one of: `completed`, `failed`, `awaiting-approval`, `timed-out`,
`blocked-config`, `interrupted`, `approval-expired`. The run enforces its own
wall clock (`--timeout`): the turn's limit first, then a minute later the run
records `timed-out`, gives its session back and exits. A provider pause (a rate
limit, an outage) is waited out within `--wait-for-provider`, resuming from the
checkpoint.

### Credentials

A service does not see what your shell exported. A run finds its provider
credential in namzu's own store (`namzu login`), a provider's own sign-in file,
or `NAMZU_HOME/schedule/daemon.env` — `KEY=value` lines, mode 0600, read by the
run and handed to provider discovery only, never put into the environment a
shell tool inherits. A run that used another program's sign-in (another coding
tool's OAuth file or keychain entry) records a warning: refreshing that sign-in from the
scheduler can race the other program's own refresh, so an unattended job is
better served by a credential of its own.

## Approvals

A call held for you parks the turn: the run records `awaiting-approval`, you get
a notification, and the job's next occurrences are skipped
(`previous-run-awaiting-approval`) until it is answered.

Answer it in the TUI, from the job's folder: a run's conversation is stored with
its folder, so `namzu resume <session-id>` finds it only there. Every place that
tells you how to answer — the notification, `/schedule`, `schedule list`,
`show`, `status` and a foreground `run-now` — gives the whole command,
`cd <folder> && namzu [--add-dir <dir>]… resume <session-id>`, quoted for a
POSIX shell (the notification only when the command fits in it whole, else it
points at `schedule show`). `namzu resume <session-id>` run from another folder
says which job the run belongs to and prints that command, and exits 64. The
command opens the conversation with the parked call already on the permission
screen (`/resume` inside the conversation does the same; a turn that is not a
scheduled run's park waits for `/resume`). **Approve** runs exactly the parked batch — the model is not asked
again — and later calls in that turn are asked of you live. **Reject** refuses
it and the turn continues. When the turn ends in the TUI — completed, failed or
cancelled — its end is recorded in the job's history and state right then, as a
scheduler's tick would record it (a running scheduler is asked to look at once
instead), so `schedule list` and `status` stop showing it waiting; a turn that
parks again stays waiting. The resumed turn stays under **the job's rules**, not
your folder's: a `deny` in the job holds even if your config allows it. It also
runs on **the job's model**: the provider and model the job pins (or, for a job
that names only a provider, the model its run started on), with no fallback
chain, whatever model the TUI session is on. Agents it starts inherit that
model too, unless they name another or their agent file pins one. There is
no "approve all" for a scheduled run: its prompt offers only **Yes** and **No**
(`y`, `n`, `1`, `2`), and its later batches are asked one at a time.

The resumed turn runs in the TUI session you answer from, so that session must
run the way the job does: in the job's folder, with the sandbox on for a job
created with `--execution sandbox` and off for one on the host, and with exactly
the job's `--add-dir` roots, no more and no fewer, and with a credential for the
job's provider (`namzu login`, or its API key). A session that differs is
refused before anything is asked, and the refusal names the difference and the
command that opens a matching session
(`cd <folder> && namzu --add-dir <dir> resume <session-id>`).

A park nobody answers within `--approval-ttl` (default 7 days) is abandoned:
the turn is closed, the run is recorded `approval-expired`, and the job runs
again at its next time.

## Missed runs, sleep and clocks

- A run is never started twice for the same scheduled time: each occurrence is
  claimed when its run starts, with a file only one writer can create.
- If the scheduler was not running (machine off, logged out, service stopped),
  **one catch-up run** is made for the most recent missed time within the last
  7 days, and the others are one `missed` record. Older ones are only recorded.
  A catch-up says so in its notification ("catch-up run for Tue 03:00, 6 earlier
  runs missed").
- A one-shot (`at`, `in`) missed by more than 7 days expires.
- Occurrences while a job is **paused** are skipped, not caught up.
- The machine is never woken to run a job.
- A backward clock change re-runs nothing; a forward one is treated as missed
  time. Each job keeps its own time zone; `list` warns when it differs from the
  machine's current zone.
- Cron follows cronie across DST: a fixed time the clocks skip runs once at the
  first minute after the gap; a fixed time the clocks repeat runs once; `0 * * *
  *` runs twice in the repeated hour.
- Editing a job's schedule never catches up times that belonged to the old one.

## When a job keeps failing

- The same failure is notified once, until it changes or a run succeeds.
- A provider that asks to be left alone for longer than `--wait-for-provider`
  puts the job on a quota hold until then (`skipped: quota-hold`).
- After `--pause-after-failures` (default 5) failed runs in a row the job pauses
  itself and tells you. `namzu schedule resume <name>` starts it again.
- Jobs that can change the folder run one at a time per folder; read-only jobs
  may overlap. At most `schedule.maxConcurrentRuns` (default 2) runs are in
  progress at once; a run that waited records how long and why.

## Notifications

A notification names the job and what happened — finished, failed, waiting for
your approval, a catch-up, a job on hold — and nothing the model wrote, unless
the job asked for its one-line summary (`--notify-summary`). At most one per job
every ten minutes and twenty a day, except the ones that need you — a run
waiting for your approval, an approval that expired, a job on hold, waiting for
confirmation or paused after failures — which are always sent.
`schedule.notifications: false` in your user
config turns them off. Where they appear: see
[The scheduler service](scheduler-service.md#notifications).

## Everything else

```sh
namzu schedule list [--json]              # jobs, next run, last result
namzu schedule show <job> [--json]        # the job in full, rules and recent history
namzu schedule history <job> [--json]     # runs, skips and missed occurrences with reasons
namzu schedule edit <job> [options]       # change it; confirmed again
namzu schedule pause|resume <job>
namzu schedule run-now <job>              # through the scheduler, or here when it is not running
namzu schedule remove <job> [--yes] [--force]  # history and run files are kept
namzu schedule prune [--older-than 30d] [--delete] # old runs and their sessions, removed jobs' too
namzu schedule logs [--follow] [--job <name>]
```

`remove` refuses a job with a run in progress or waiting for approval unless
you pass `--force`. A forced removal leaves a running run to finish, and its
end is still written to the removed job's history; a run waiting for approval
has its turn closed and is recorded as `cancelled`, since nobody can answer it
once the job is gone.

`prune` covers removed jobs as well (without `--job`): their run files and run
sessions older than the cutoff, and their history once no run of theirs is left.
A removed job's run whose history still shows it open counts as over once its
result file says so or no process holds its session.

`run-now` with no scheduler running runs the job in your terminal, recorded as
the job's run in progress exactly as a scheduled run is: a scheduler that
starts meanwhile does not start the job beside it, and a run that parks waits
for your approval, holds later occurrences and expires like any other. A run
stopped by its wall clock, by Ctrl-C, or by closing the terminal is recorded
(`timed-out`, `interrupted`) before the process exits; one whose process was
killed outright is settled by the next `run-now` or the scheduler, as soon as
nothing holds its session.

`--json` shapes: `list` prints `{ "v": 1, "jobs": [{ id, name, state, schedule,
tz, folder, nextFireAt?, lastRun?, activeRun?: { status, sessionId?,
resumeCommand? } }] }`, `resumeCommand` for a run waiting for approval; `show` prints `{ "v": 1,
job, state, history }`; `history` prints `{ "v": 1, "job": { id, name },
"records": [...] }` with records newest first, a run's last status winning.

In the TUI, `/schedule` is the same list with actions, and the `schedule` tool
lets a model propose a job — always confirmed by you on a screen namzu draws
from its own computation, never from the model's words. See
[Session loops](session-loops.md) for `/loop`, which repeats a prompt inside an
open session instead.

## Files

Everything lives under `NAMZU_HOME/schedule/`; [Session storage](session-storage.md)
lists each file and whether it is safe to delete. Nothing is written in the
job's folder by the scheduler itself.

## Limits

- Jobs run while you are logged on (macOS, Windows, WSL) or while the systemd
  user manager runs (Linux; `install --at-boot` keeps it running without a login).
- No job wakes the machine.
- There is no chaining, no delivery elsewhere than the notification and the
  session, and no per-run worktree.
