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
| `--token-budget <n>`, `--max-iterations <n>`, `--timeout 30m` | Per run. A token budget and a timeout are always set (defaults 500 000 tokens, 30 minutes, or your `limits`). An iteration is one model call with its tool calls (default 50); below 10 iterations or 50 000 tokens the confirmation warns that a run may stop unfinished, since every model call resends the whole prompt |
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

Asking in words in the TUI composer ("schedule this", "run it every day",
"bunu her sabah çalıştır") only offers a [composer trigger](composer-triggers.md)
— `✧ schedule? · alt+w: the agent proposes a job; you confirm it on screen` —
because such words usually describe the code being written. Armed with Alt+W,
it asks the model to propose a job with the `schedule` tool, which ends on the
same confirmation; it never asks for a session loop.

An edit is confirmed again whole, and above the question it lists what changed
since the job was last confirmed, `+` for a line added and `-` for one removed
(`Changed since it was last confirmed`). An edit saved with `--yes` records
those lines in the job's history (`changes` on its `edited` record), so
`schedule confirm` and `/schedule confirm` show them too.

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
   - **anything that could name the Windows browser's profiles**,
     `%LOCALAPPDATA%\namzu`, where namzu keeps the profiles it drives from
     WSL, with the cookies of every site you signed in to, outside
     `NAMZU_HOME`. The floor does not know the user folder above it, so it
     matches the last three segments, `AppData/Local/namzu`, in any letter
     case and with either slash, wherever they stand (`/mnt/c/Users/<you>/…`,
     a quoted `C:\Users\<you>\…`, or a job folder that happens to contain
     them). It reads the same words, redirections, `cd`s and variables as
     above, with `$LOCALAPPDATA`, `%LOCALAPPDATA%` and `$env:LOCALAPPDATA`
     spelled out. `namzu2`, `namzu.bak` or `AppData/Roaming/namzu` is another
     folder. A word with a glob or an unknown variable is refused when its
     segments could still read `AppData/Local/namzu` and one of them is
     spelled out (`/mnt/c/Users/*/AppData/Local/nam*`, `…/AppData/Local/*`),
     or when an unknown variable is followed by a `namzu` segment
     (`$X/namzu`). An unquoted `C:\Users\…\namzu` is not refused, because
     bash drops the backslashes and passes `C:Users…namzu`, a file in the
     current folder. Passed to `cmd.exe` or `powershell.exe`, the same text
     is something the lexer does not read, and the tripwire below refuses it
     as a path into the profile folder;
   - **what the lexer cannot account for, when it mentions what the floor
     protects.** A line is opaque when it holds a command substitution, a
     function, `[[ … ]]`, arithmetic on a variable, a syntax error or another
     construct listed under [When a line is
     opaque](../sdk/command-lines.md#when-a-line-is-opaque). A command also
     escapes the reading when its name expands (`$S --user stop …`) or when it
     runs text as code: a shell the lexer did not follow (`bash` reading its
     input or a script, `sudo bash -c`, `env -S`, and any shell other than
     `sh`, `bash`, `dash`, `zsh`, `ksh`, `ash` and `mksh` even with `-c`:
     `powershell -c`, `pwsh -c`, `fish -c`, `tcsh -c`, `bash.exe -c`),
     `eval`, `source`, `.`,
     `xargs`, `watch`, `ssh`, `su`, `python`, `node`, `perl`, `ruby`, `awk`,
     `sed` and the like, and `powershell`, `pwsh` and `cmd`. Such a line is
     refused when its text — as written, with quotes and expansion marks
     dropped, with backslashes dropped too, and in every word the lexer
     decoded — holds something that can reach what the floor protects:
     - `NAMZU_HOME` by name (`$NAMZU_HOME`, `%NAMZU_HOME%`,
       `os.environ['NAMZU_HOME']`), its last segment as a path segment
       (`.namzu`, always, so `$env:USERPROFILE\.namzu` too), or a path into
       it;
     - the Windows browser's profile folder as a path, or `LOCALAPPDATA`,
       `LocalApplicationData` or `AppData` with `namzu` as a segment or a
       string of its own (`Join-Path $env:LOCALAPPDATA 'namzu'`);
     - the scheduler service's name: `namzu-scheduler…` (the unit, and the
       Windows task `namzu-scheduler-wsl-<distro>`) or `com.namzu.…` (the
       launchd label);
     - a service tool — `systemctl`, `launchctl`, `schtasks`, `busctl`,
       `dbus-send`, `gdbus`, PowerShell's `Stop-`, `Disable-`,
       `Unregister-` or `Set-ScheduledTask`, `Schedule.Service` — with
       `namzu` or a `*` in the text, or `systemctl isolate` or `exit`; and
       `pkill` or `killall` anywhere, because a pattern can match the
       scheduler's `node` process without naming namzu;
     - `schedule` as a command word followed by anything but `list`,
       `show`, `status`, `history` or `logs` (or by nothing, as in
       `xargs … namzu schedule`), when the text also names the CLI
       (`namzu`, `@namzu/cli`, a `bin.js`, `node`, `npx` …) or holds an
       expansion that could (`$cli`, a backtick, `%CLI%`).

     The product's name alone is not on that list: `[System.Windows.MessageBox]::Show('Namzu: scheduled job running','Namzu')`
     passed to `powershell.exe` runs, as does `python3 -c "print('namzu
     done')"`. 29.1.0 refused both for naming `namzu` (and the first for
     `schedul`). Text such a program may run — an argument, a
     here-string, a here-document's body — is read as a command line of its
     own, so `echo $'…\x6e…' | sh` is refused when its decoded text would
     be; otherwise it is not: `echo "$(date)" >> run.log` runs.

   A refusal names the rule that matched and where, not the whole list: for
   `powershell.exe -Command "namzu schedule stop"` it reads ``the
   scheduled-run floor refused this call: `powershell.exe` runs commands the
   floor does not read, and it holds `schedule stop` (a `namzu schedule`
   subcommand other than list, show, status, history, logs), in the argument
   `namzu schedule stop` ``; for `cat ~/.namzu/x`, ``the argument
   `~/.namzu/x` names NAMZU_HOME (…)``; for another tool, the argument by
   name (``the `content` argument names NAMZU_HOME``). The floor gives the
   gate that reason through the `predicate` rule's `describe`.

   Every other tool's arguments are read as text, at any depth: a string
   naming `NAMZU_HOME` by path, as `~/…`, `$HOME/…` or `${HOME}/…`, or as
   `$NAMZU_HOME`, in any letter case, is refused, and so is one that would
   once a shell dropped its quotes and backslashes (`~/.nam"z"u`). So is a
   string naming the Windows browser's profiles, as a path through
   `AppData/Local/namzu` with either slash or through `%LOCALAPPDATA%`,
   `$env:LOCALAPPDATA` or `$LOCALAPPDATA`.

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
   reads under `~`) was refused. The Windows profiles were checked the same
   way: 27 000 more lines, three in four naming a path near
   `AppData/Local/namzu` in every spelling above, run with the profile tree
   at `/mnt/c/Users/u/AppData/Local/namzu` and `LOCALAPPDATA` set to
   `C:\Users\u\AppData\Local` as a run inherits it. Every one of the 9 068
   lines whose run reached the scheduler, `NAMZU_HOME` or the profiles
   (an argument or open file inside them, or the text of one a Windows
   program would read) was refused. When the tripwire stopped refusing the
   product's name (29.1.x), the same 35 159 lines (seeds 11–14 in bash,
   31–33 in `sh`, the 159 ordinary lines) were run again: still every
   dangerous line refused, and the share of harmless lines refused fell from
   42% to 30% in bash and from 76% to 47% in `sh`, the rest being scheduler
   words and path fragments the generator plants in unreadable text on
   purpose. On 1 189 labelled lines of code text for PowerShell, `cmd`,
   Python, Node and `sh` (half of them reaching the scheduler, `NAMZU_HOME`
   or the profiles, half only mentioning namzu or "scheduled"), 72% of the
   harmless ones were refused before and 7% after (every one of those a
   PowerShell string starting `namzu …` with a `$(…)` in it, read as a
   possible call to the CLI), and 92 dangerous ones — every
   `powershell -c` or `pwsh -c` among them — had run unread before 29.1.x
   took the lexer's own word for which `-c` payloads it follows; none do
   now;
3. every `deny` in your user, project and managed config files, each file read
   on its own. **Allows come only from the job**: a config `allow` never widens
   a job, and a config `deny` ("we never force-push") always holds;
4. the job's own rules, then its [browser grant](#browser-access)'s site
   rules; `web_fetch` and `web_search` the job does not name, and `browser`
   and `browser_act` beyond the grant, are denied here;
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

## Browser access

A job can drive a browser, signed in as you, on the sites you list and no
others. Sign in once in a visible window with
`namzu browser login <profile> <url>` ([The browser](browser.md#profiles-and-signing-in)),
then give the job the profile and the sites:

```sh
namzu browser login social https://social.example/login
namzu schedule add good-morning --prompt "Post 'Günaydın!' with the time" \
  --when "every 5m" --permissions read-only --unmatched park \
  --browser social --browser-site https://social.example=act
```

`--browser-site <site>=<level>` is repeatable. A site is an origin
(`https://github.com`, `https://*.example.com`, `http://localhost:*`),
canonicalised when the job is created; `*` is refused, and every site the job
does not list is denied.

| Level | Open and read pages | Click, type, fill forms |
|---|---|---|
| `read` | yes | no |
| `ask` | yes | waits for you, as a held call (needs `--unmatched park`) |
| `act` | yes | yes |

The grant is stored in the job's permission set (`permissions.browser`:
`profile`, `sites`, `headed`), is part of what a confirmation vouches for, and
counts as network access (`Network THIS RUN CAN REACH THE NETWORK`). The
confirmation and `schedule show` add `Browser SIGNED IN AS YOU: profile <p>,
only <sites>` and one line per site:

```text
browser: profile social, no window
browser https://social.example: open, read and change without asking
browser any other site: deny
browser sign-in, CAPTCHA or a code: the run stops and tells you
```

The `[permissions]` rules of a job cannot name `browser` or `browser_act`; the
grant is the only way in. Without one both tools are denied. A site any config
file's `browser.sites` denies stays denied, whatever the grant says. Looking
at the page the browser holds, and `back`, `forward` and `reload`, are
allowed; the browser itself checks where every navigation lands against the
same sites. The model's `schedule` tool can propose a grant in the TUI
(`permissions.browser`); you confirm it on screen like any proposed job. A
proposal that pairs a browser grant with a shell on the host is refused;
`read-only` has none.

Before the model is called, a run with a grant checks that the profile exists
and still has its data, that the browser it was signed in with can start here
(for the Windows browser from WSL: interop, `powershell.exe` and Chrome or
Edge, found by a service through `/run/WSL`), and that a window can be shown
when the job asks for one (`--browser-headed`; `DISPLAY`, `WAYLAND_DISPLAY`
and `XAUTHORITY` reach the run). Otherwise the run is `blocked-config` with the
command to fix it, e.g. `browser profile social does not exist; sign in once
with namzu browser login social https://social.example`. The run never
switches to another browser: a profile signed in with the Windows Chrome has
its cookies there. There is no window unless the job has `--browser-headed`.

A page that needs a person — a sign-in form, a second factor, a CAPTCHA — stops
the run: it parks as `awaiting-approval` with the page's reason, the
notification says `needs you (since …): <page> is showing a sign-in page; sign in
again with namzu browser login <profile> <url>`, and `schedule list`,
`show`, `status` and `/schedule` say `needs you: <reason>` instead of waiting
for approval. Sign in again with `namzu browser login`, then
`cd <folder> && namzu resume <session-id>` and choose **Continue**: the turn
drives the job's profile, held to the job's sites, and your session's own
profile comes back when it ends. The model is told the same in its system
prompt: it never types a password or a code and does not look for another way
in.

`schedule edit` changes the grant: `--browser-site <site>=<level>` adds a site
or changes its level, `<site>=none` takes one off, `--no-browser` removes the
grant. Like any edit, it is confirmed again, and a job saved without a
terminal (`--yes`) is held until you confirm it.

## One run

The scheduler starts each run as its own process, `namzu schedule __fire`, in
the job's folder, with a new conversation titled `⏲ <job> · <time>`. Before the
model is called — zero tokens spent — a run checks that the job is still the
one confirmed, the folder is still the canonical folder it trusted, the
project config matches its pin, every rule compiles, and the pinned provider
has a credential **as the service sees it**. Any failure is `blocked-config`
with the reason.

The run's system prompt says nobody is watching, gives the local time, and
asks for the final answer — the run's record — in the language the job's
prompt is written in. The `schedule-task` skill asks the model to write a
proposed job's prompt in the language you write to it in.

A run is not sent the tools its job can never use: a tool a `deny` names
before any rule could let it through (`bash`, `edit` and `write` under
`read-only`, the web tools the job does not name, the browser tools without a
grant), the background-job tools once `bash` is out, and under
`unmatched: deny` the agent and memory-writing tools no rule names, with the
advice on delegating that goes with them. Each model call resends every tool
schema: a browser job posting once on a small site used six calls of about
15 000 prompt tokens, about 106 000 tokens a run; without the tools it could
never call, about 11 500 a call and 78 000 a run. A call to a withheld tool is
refused as an unknown tool.

The run's system prompt tells the model it is unattended: no questions
(`ask_user_question` is not offered), calls outside its rules wait or are
refused, and background jobs end with the run. It also gives the time the run
started, in the job's zone (`--tz`, else the host's), with its offset: `It is
now Wednesday, 23 September 2026 at 21:04 GMT+03:00 (Europe/Istanbul)`, and
says this is the local time already looked up, not to be fetched with `date`.
The rest of the prompt carries the date only, and a run with no shell used to
guess the time in UTC. A parked run continued from the TUI is told the time
again, as it is then: an answer can come days later.

A run ends as one of: `completed`, `failed`, `awaiting-approval`, `timed-out`,
`blocked-config`, `interrupted`, `approval-expired`. The status says how the
turn ended, not what its tool calls did, so a run whose only command was
refused ends `completed` — the model was answered and finished. Beside the
status, a run records the calls that did not do what they were for:
`refusedCalls` (never ran: a rule, the scheduled-run floor, `unmatched: deny`,
a tool its permissions withhold) and `failedCalls` (ran and returned an
error), each `{ count, first: { tool, reason } }`. They are in the run's result
and history record, the job's state (`lastRun.refusedCalls`,
`lastRun.failedCalls`, counts only), `list` (`last completed (1 call refused)
11:03`), `show` and `history` (`1 call was refused (bash: the scheduled-run
floor refused this call: …)` under the run), `run-now`, `/schedule` and the
model's `schedule` tool `list`. There is no separate status for it: every
reader of a status — the failure streak and automatic pause, which
notification is sent, catch-up, a `v: 1` history an older namzu reads — would
have to decide whether such a run failed, and a run that failed or timed out
can have refused calls too. In the operator's first trial a job's only
command was refused on every run and each was recorded `completed` with a
`finished` notification and nothing else. The run enforces its own
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
created with `--execution sandbox` and off for one on the host (only for a job
that can run a command: one whose `bash` is denied, such as `read-only`,
continues the same either way), and with exactly
the job's `--add-dir` roots, no more and no fewer, and with a credential for the
job's provider (`namzu login`, or its API key). A session that differs is
refused before anything is asked, and the refusal names the difference and the
command that opens a matching session
(`cd <folder> && namzu --add-dir <dir> resume <session-id>`).

A run can also park because a tool asked for a person
([Tool handoff](../sdk/tool-handoff.md)): a sign-in page, say. The results are
recorded and the model is not called again. The run records `awaiting-approval`
with the tool's reason as its `reason` and in `handoff.reason`, and the
notification says `needs you (since …): <reason>` with the command that opens
it. There is no batch to approve. `namzu resume <session-id>` (or `/resume`)
shows the reason and offers **Continue** or **Abandon**. Continue resumes the
turn under the job's rules and on its model, and its next step is a model call
that sees the results and is told that the person dealt with what the tool
asked for, with the current time, so it tries the step again instead of
reading the tool's refusal as final. Abandon closes the turn, and the job stays scheduled.
Esc leaves the run waiting. The same folder, sandbox, roots and credential
checks apply as for an approval.

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
the job asked for its one-line summary (`--notify-summary`). A finished run
with refused calls says so: `done at Thu 11:03, but 1 call was refused (bash);
namzu schedule show <job> says why`. The reason can quote the command the model
wrote, so it is in the notification only for a job that asked for its summary
(`done at …, but 1 call was refused: the scheduled-run floor refused this call:
…`), cut to fit. At most one per job
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
resumeCommand?, handoff? } }] }`, `resumeCommand` for a run waiting for
approval and `handoff: { reason }` for one a tool parked for a person (the
text list says `needs you: <reason>` for it, not `WAITING FOR APPROVAL`); `show` prints `{ "v": 1,
job, state, history }`; `history` prints `{ "v": 1, "job": { id, name },
"records": [...] }` with records newest first, a run's last status winning. A
run record and `lastRun` carry `refusedCalls` and `failedCalls` when a run had
any (see [One run](#one-run)).

In the TUI, `/schedule` is the same list with actions, and the `schedule` tool
lets a model propose a job — always confirmed by you on a screen namzu draws
from its own computation, never from the model's words. That screen is the
only question: the tool's `create`, `resume` and `delete` skip the ordinary
permission review ("Do you want to run schedule?") in `prompt`, `accept-edits`
and `auto`, as they draw their own. `plan` and `strict` still refuse them, a
`schedule: ask` or `deny` rule still applies, and `pause` is reviewed as
before. Every optional value the model set to something other than what you
would get by leaving it out — a time zone other than this machine's, a folder
other than the session's, the sandbox, a budget, a visible browser window —
is marked on the confirmation: `Chosen by the model, not the default: time
zone America/New_York, not this machine's Europe/Istanbul`. When no scheduler is
installed, the line that says the job was created also says it does not run
until `namzu schedule install`. The tool's `update` changes a job in place
the way `schedule edit` does: the confirmation starts with what changes
(`Changed since it was last confirmed`, `-`/`+` lines), says `THE PERMISSIONS
CHANGE` when the rules, `unmatched`, where it runs or the browser grant do,
and then shows the job as it will run, whole; `Cancel` is the default and
`Save` writes the same job, its id and history kept, with your new
confirmation (`tool-confirmed`), paused if it was paused. Its history records
`edited by tool` with the changes. The tool's `list` shows every job in
`NAMZU_HOME`, whatever folder it runs in and whatever `allFolders` says, as
`namzu schedule list` does; the jobs of the session's own folder are marked
`(this folder)` and are the only ones whose prompt the model is given. It used
to list only the session folder's jobs unless the model passed `allFolders`,
so a model that had just created a job in a folder below the session's was
told "No scheduled jobs.". See
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
