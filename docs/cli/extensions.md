---
type: Reference
title: Extensions
description: Separate programs you add from a signed file. What `namzu extension` does, where an extension's files live, the licence key, the notice you acknowledge once, how updates that ask for more wait for you, what the host refuses at run time, and how a running extension says so.
resource: packages/cli/src/integrations/extensions
tags: [cli, extensions, consent, signing, privacy]
status: stable
generated: { by: process:agent, at: 2026-11-18T00:00:00Z }
---

# Extensions

An extension is a **separate program** that Namzu runs for you and supervises. It is
not a plugin: a plugin is JavaScript loaded into the Namzu process, an extension is a
signed package, its own process, with a manifest that says what it asks for and why.
Namzu ships only the platform that adds, checks, runs and stops extensions. No
extension is inside Namzu's packages or installer; a person adds one from a
`.nzx` file with `namzu extension add <file>` or from Desktop (**Add from file**).

This version only **collects**. There is no organisation management, no analysis and no
model call; the only traffic an extension can have through Namzu is the licence check its
manifest declares. An extension may draw its own pages inside Namzu, may use a licence of
its own service or none, and may start when you sign in. The manifest format is in
[Extension manifest](extension-manifest.md); the Desktop page is in
[Extensions in Desktop](desktop-extensions.md).

## What you are told, and when

`namzu extension add` verifies the package and prints, from its manifest alone, what it
asks for: each permission with its level and **every purpose in plain words**, that it
what network it uses (none, or the named hosts and why), where its data lives, each kind of data with its fields and
how long it is kept, what it does not collect and does not do, whether an administrator
of the computer can read the data, and whether a licence is needed. A permission without
a purpose is refused when the package is added. `add` starts nothing and asks for
nothing.

The first time you **enable** an extension, Namzu shows its notice and asks you to
acknowledge it. A decline writes only an audit line and leaves the extension off. The
acknowledgement is taken **once per person (OS user) per extension**. It is kept with the
notice version, a hash of the permissions, purposes, data and retention you were shown,
a digest of the wording, the language shown, and a hash of the OS user. It is read-only
for you at any time:

```text
namzu extension notice <id>        the notice again, with when you acknowledged it
namzu extension status <id>        the same record and the last audit lines
```

A restart, a reboot, disable then enable, a crash, and an update with the **same or a
narrower** scope never ask again. A record copied from another user or computer does
not cover (the user hash differs). Only a **wider** scope asks again: a new permission,
a new purpose, a new data kind or field, a data kind that now reads another permission,
a longer retention, something that now leaves the computer, new file access, a changed
network mode or kind of monitoring, running at log on, an optional permission that
became required, or a **new notice version**. An update that asks for more is
**staged**: the version you have keeps running under what you acknowledged, `list` shows
`update-waiting`, `notice <id> --staged` shows what it now also asks, and one
acknowledgement swaps it in. Someone who never acknowledges stays on the old version.
A narrower update swaps at once and the record is replaced by the narrower scope.

A change of the default-language wording of the notice, a permission summary, a purpose,
a data description or the privacy block must come with a new notice version: an update
that changes the words under the same version is refused. A translation fix is not a
wording change.

An **optional** permission is off until you grant it later, with its own prompt and its
purposes (`namzu extension grant <id> <permission>`); `revoke` takes it back and
restarts the process without it. Granting needs a person at a terminal, or Desktop.

## Commands

Every command takes `--json`. Exit status: `0` done, `1` refused, `75` needs a person
(the notice has to be read at a terminal, or in Desktop), `64` the command line is
wrong, `66` a file is missing.

| Command | What it does |
|---|---|
| `add <file.nzx>` | Verify the package, print what it asks for, say what is next. A package for an installed id is an update. |
| `list` | One row per extension: id, name in your language, version, state, the mark, and `DEV KEY` when a developer key signed it. |
| `status <id>` | Why it is or is not running, restarts in the last hour, its own report, licence, record, a waiting update, the last audit lines, and that the managed settings layer is not used by extensions in this version. |
| `notice <id> [--staged] [--locale <tag>]` | Print the notice and the record. Changes nothing. |
| `license <id> [--file <path>\|--key-stdin\|--refresh\|--release]` | Enter a licence: a key file, or for a licence service a key from standard input or a prompt, never as an argument. `--refresh` checks again now, `--release` frees this computer's seat. |
| `enable <id>` | Check the licence, show the notice and ask once if nothing covers it, then enable. There is no `--yes`. |
| `unlock <id>` | Take the administrator lock off. Needs the administrator password. |
| `disable <id>` | Turn it off. Data and your record stay; enabling again asks nothing. |
| `remove <id> [--delete-data]` | Remove it. Your record is kept for the time the notice states, so adding it back with the same scope asks nothing; after that it asks once. |
| `grant` / `revoke <id> <permission>` | An optional permission. |
| `key <id> <provider> [--stdin\|--remove]` | The model API key row, stored apart from your own keys and used by nothing in this version. |
| `background <id> on\|off\|status` | The Start when I sign in switch. Each flip is an audit line. |
| `daemon start\|run\|stop\|status` | The background runner (one per person). `start` starts it if none runs; `run` is the foreground form the sign-in entry reaches (on Windows the task runs `start.vbs`, which runs `start.cmd` hidden, whose last line is `extension daemon run`, because the task is already the runner's parent and `start` would only ask the same task to run again); `stop` shuts down what it runs cleanly first. |
| `signin remove --all` | Remove the sign-in entry and its launcher (for an uninstaller). Never data. |
| `run` | A headless host: supervise every enabled extension until interrupted, printing the mark to standard error. |
| `validate <folder\|file>` | The developer's check: the manifest and its rules, and for a package the hashes and, when a trusted key is available, the signature. |

An enabled extension runs while a Namzu host runs: Desktop, an interactive terminal
session, or `namzu extension run`. One host per OS user owns the process; the others only
read. When the owner exits the next host that notices starts it again without asking.

## The package, the signature and the licence

A `.nzx` is a zip with a manifest, a list of every file's hash, and a signature over the
manifest and that list under a domain line, so no other signed thing can pass as one. A
package is refused before anything is written if it has an absolute path, `..`, a
backslash, a control character, two names that differ only by case, a link or device
entry, more than 500 entries or 64 MiB unpacked, a compression ratio above 100 to 1, a
file the list does not name or a listed file that is missing or changed. The files are
checked again at **every start**: a file changed on disk after install stops the next
start with `tampered`.

Publisher keys are compiled into the build. A key belongs to one publisher and may sign only
the ids it covers: this build trusts Cogitave's key `cogitave-2026`, for publisher `cogitave`
and ids starting with `com.cogitave.`. A package signed by any other key is refused with "This
file was not signed by a publisher Namzu trusts". A developer key is trusted only when **both** `NAMZU_EXTENSION_DEV=1` and
`NAMZU_EXTENSION_TEST_PUBLIC_KEY=<keyId>:<base64>` are set, and then everything prints
`DEV KEY`. There is no "trust this key" button and no trust on first use.

A licence is optional: an extension declares `none`, `key` or `service`. A **key** licence is an offline, signed file naming the extension, a customer, seats, a start and
an expiry. It is checked when you enter it, at every start and on every host check. A
clock set back more than a day behind the latest time Namzu has seen makes it invalid.
Seats are shown and not counted. When it expires while the process runs, the host stops
the process (the state is `license-expired`, the mark says so), the maintenance command
that only deletes expired rows still runs, the data stays readable for its retention, and
a valid licence entered later resumes it with **no** new notice.

## Where things live

Per OS user, under `$NAMZU_HOME/extensions` (mode 700):

```text
<id>/state.json      active and staged version, enabled, the clock high-water mark
<id>/versions/<v>/   the unpacked package, read-only
<id>/data/           the extension's own folder; the host never reads inside it
<id>/consent.json    your record (notice version, scope hash, grants, history)
<id>/license.json    the licence (mode 600): the signed file, or for a service the cached signed answer
<id>/license-secret.json  a service licence key, kept by Namzu (mode 600), never returned or shown again
_runner/             the sign-in launcher, the runner's lock, control channel, state and log
<id>/keys.json       the secret settings (mode 600), apart from Namzu's own keys
<id>/audit.log       counts and codes only, rotated at 2 MiB
_removed/<id>.consent.json   your record after a remove, kept for the notice's retention
```

## What the host refuses at run time

The process is started directly (no shell) from the package folder with an environment
built from scratch: no `NAMZU_*` variable but `NAMZU_EXT_*`, no API key, never the secret
setting. It talks to the host over standard input and output and serves a local read-only
query endpoint (a named pipe for the owning user on Windows, a Unix socket in a private
folder elsewhere). The extension is shown as running only once that endpoint accepts a
connection, so a query issued the moment it shows as running reaches it; one that does not
open within 10 seconds of its first status is stopped and restarted like a missing `hello`.
The host refuses what the manifest did not declare:

| Code | Refused |
|---|---|
| R1 | a query that is not declared (before anything is sent) |
| R2 | an answer that does not fit its schema, is over its size or is not JSON |
| R3 | an answer naming a kind or a column the query does not declare |
| R4 | a `hello` naming an undeclared permission, or an optional one that was not granted: the process is stopped and shown as failed |
| R5 | any message type other than `hello`, `status` and `log`: three in a row stop it |
| R6 | a state or a signal the manifest did not declare: shown as degraded |
| R7 | a setting the manifest did not declare |

The host cannot intercept the extension's own operating system calls. What it enforces in
this version is declaration, consent, tamper-evidence, the clean environment, the
validated read-only answers, the lifetime and the mark; it audits the rest. Limits on
memory and CPU are reported, not enforced.

A process that exits without being asked, even with status 0, is a failure and is
restarted with the manifest's backoff; after the manifest's cap per hour it is `failed`
and waits for you to start it again. A process must exit by itself within five seconds of
its standard input closing, so a hidden orphan cannot outlive the host, and the next host
kills a leftover of the extension.

## The always-visible mark

While an extension runs it says so, always, with no setting to hide it: a dot and a
sentence in the terminal (a row under the composer) and, in Desktop, in the extension's row and on
its screen in Settings, Extensions (never in the window's title band, and never on Namzu's tray
icon: a tray mark is the extension's own). The host
computes it from the live process. The extension supplies only the sentence for the two
states it may report; the host's own sentences for starting, not responding, failed,
licence expired and waiting for the notice cannot be changed or hidden by a manifest.

## Licence: none, key or service

`licensing.kind` decides which screens exist. **None** has no licence screen, no licence state
and no licence chip: an unlicensed extension runs after the notice. **Key** is the offline file
above. **Service** is the publisher's own licence service, which the manifest names as the only
network the licence check may use (an https host declared `for: license`). Namzu makes every
request itself and keeps the key; the extension process never sees it. It can read the claims of
the answer (customer, seats, features, expiry), which Namzu has checked, without the key and
without the activation id. The signed envelope itself is not handed to the extension, because
its payload carries the activation id.

The protocol is `namzu-license/1`: `POST {baseUrl}/activate` (the key and a code for this
computer), `/refresh` (an activation id and the code; no key) and `/release`. Transport is
https only, no redirect, 10 seconds, small bodies, no cookies and no credentials header, and a
process started with certificate checks switched off makes the check refuse to run. The code
for this computer is an HMAC per extension, not a hardware id or a name; it counts seats and is
not an anti-copy boundary (a copied Namzu home copies the secret).

A success is a signed envelope: an Ed25519 signature over `namzu-license-answer/1\n` and the
payload, checked in order against the key in the package, the extension, **this machine, the
nonce sent with this very request** (so an answer cannot be replayed), the time (within ten
minutes of now) and a lifetime of at most 30 days. `suspended`, `revoked` and `expired` arrive
as signed answers, never as HTTP errors, so nobody on the network path can end a licence by
forging a status code; an unsigned error never changes a licence state, it only counts as
"could not check". A refresh is due `refreshHours` after the last answer and only while the
extension is enabled; a failed attempt retries after 1, 5 and 30 minutes, then every 2 hours.
After `validUntil` the cached answer keeps the extension running for `offlineGraceDays` with a
visible notice ("Licence not checked, N days left"); after that, or on a signed `revoked`, it
stops. A clock more than a day behind the last time Namzu saw it makes the licence invalid.
The cached answer is checked again **every time it is read**: Namzu verifies the signature on
the stored envelope and takes the status and the lifetime from the signed bytes, never from the
file's own fields, so editing `license.json` (a later date, `active` in place of `revoked`) changes
nothing, and a file whose envelope does not verify counts as no licence. Removing the extension
tells the service to free the seat, as a best effort that never blocks.

## The administrator lock

An extension that declares `management.lock` in its manifest (see
[the manifest](extension-manifest.md#the-administrator-lock-management)) is turned on with an
administrator password. The person or the IT team who turns it on sets it: in Desktop, a password
typed twice on the notice screen (or in a dialog when the notice was already read); on the command
line, `namzu extension enable <id> --admin-password-stdin`.

While it is set, these need the password: `disable`, `remove` (also with `--delete-data`), `background
<id> off`, `license` (a new key, a file, `--release`), `revoke`, `key`, `unlock`, and `daemon stop`
while a locked extension runs in the runner. Turning things on, granting a permission and reading
are not ways off and ask nothing. The password is never an argument: it is the **first line of
standard input** with `--admin-password-stdin`, and a licence or key you pipe in follows on the next
lines. Desktop asks in a dialog, and the extension's screen says "Locked by your administrator"
with an **Unlock** row. A wrong password is refused and the next try waits 1 second, then 2, 4 and so
on up to a minute (a try inside the wait is not even looked at); the wait is kept on disk, so the
app, the command line and the runner all honour it. A refused try is a line in the event history
(`unlock-failed`, with the operation and never the password), as are setting and removing the lock.
`enable` on an unlocked extension that declares the lock asks for a new password.

A try is counted and its wait is written **before** the password is hashed, under a small guard file
(`lock.json.guard`, taken exclusively, a left-behind one is taken over after ten seconds). Fifty
`namzu extension disable` processes started at once therefore meet the wait the first one reserved
instead of each being judged; a right password clears it again. An **update that adds the lock to an
extension that is already on** asks for the administrator password when its notice is acknowledged
(`--admin-password-stdin` on the command line, the password fields on the notice screen in Desktop);
without it the acknowledgement is refused and the old version keeps running. **What the lock does not
cover**: adding a newer package over a locked extension is not guarded (an update still goes through
its notice), so an extension's own lock text must not promise control over its version.

Only a slow salted hash is kept: Node's scrypt (N 32768, r 8, p 1) with a random salt for each
extension, in `lock.json` in the extension's own folder, never in its data folder and never named to
the extension. **What this is not**: it stops turning the extension off *in Namzu*. It is not a
protection against someone who is an administrator of the computer and deletes files, ends processes
or removes the sign-in entry from the system; the file can be read by the same OS user, which is why
only a hash is kept. That needs a managed policy, which is phase 2. The lock never hides the
extension: the tray mark, the notice and What is collected stay.

## Start at sign-in and keep running when Namzu is closed

An extension may declare `background` and the permission `background.signin`, with a purpose
like any other. The install dialog and the notice say "Starts when you sign in and keeps
running when Namzu is closed" and, in the same place, what the extension itself shows while
Namzu is closed. The acknowledgement screen has a **Start when I sign in** switch, set to the
manifest's default, and the answer is recorded with the consent. The person turns it on or off
later (`namzu extension background <id> on|off`, or the extension's screen in Settings in Desktop); every flip is an audit
line and asks nothing again, because the scope the person acknowledged covers it. An update
that **adds** background running, removes the extension's own mark, adds a network host or
lets a page use the network is wider and is staged like any other.

Namzu registers **one** per-user entry for all background extensions. It names Namzu's own
generated launcher, never an extension's file, so the signature and hash check, the licence
check, the consent check and the clean environment hold while the app is closed. The launcher
reads where the engine is now from `_runner/engine.json`, which every Namzu host rewrites when it
moves, so an update of the engine needs no new entry. The entry exists exactly while at least
one extension is enabled with its switch on, and is removed with the last one.

| System | The entry |
|---|---|
| Windows | a Task Scheduler task `\Namzu\Extension Runner` at log on for the current user (least privilege, visible in Task Scheduler, restarts on failure); `HKCU\...\Run` if a task cannot be created without elevation. Which one worked is shown. No administrator rights are requested and `HKLM` is never touched. Both start `wscript.exe //B //Nologo _runner\start.vbs` and not `start.cmd`, so **no console window** appears: a `.cmd` file always gets one, and the task's `Hidden` setting only hides the task from the list. `start.vbs` runs `start.cmd` with window style 0 and waits for it, so the task stays the runner's parent. It was chosen over `conhost.exe --headless` because that switch is undocumented and needs a recent Windows 10; the script host is on every supported Windows and needs no administrator rights. A computer whose policy turns the script host off cannot start the runner at sign-in (the app still starts it). The `cmd start` fallback is hidden too, and every child Namzu starts uses `windowsHide`. An entry an earlier version registered (one that ran `start.cmd` itself) would open a console that stays as long as the runner runs, so the app repairs the entry before it first asks it to start the runner, and so does `namzu extension daemon start`. The repair compares the program the task or the Run value really starts, and the script it hands that program, with the hidden launcher's, by file name, so a profile folder with letters outside ASCII (which `schtasks` and `reg` print in the console code page) still matches. When they differ it registers the entry again, even if no launcher file changed. An entry the person switched off is never re-registered. |
| Linux | an XDG autostart file `namzu-extension-runner.desktop` under `$XDG_CONFIG_HOME/autostart`. It runs in a desktop session; a server or an ssh login does not start it. |
| macOS | a LaunchAgent for the current user, loaded for the person's own session. |

An entry the person switched off in the system is respected: Namzu records that, says so on the
card ("Your computer has switched off starting at sign-in for Namzu"), and never switches it back
on. The Windows and macOS command lines are checked in unit tests only; whether a standard user
can create a log-on task on Windows is settled on a real machine, and either result is handled.

`namzu extension daemon` is the **runner**: the same host as in the app, headless, one per person
(a lock with a start token), supervising **only** extensions that are enabled with the switch on.
The app attaches to it instead of starting a second one and shows who runs an extension ("Running
in the background"); quitting the app does not stop it, that is the point. A runner that cannot be
reached makes the app keep such an extension running itself while it is open. A runner with
nothing to run exits after a minute. A lock names the process that holds it by its start time as
the system reports it (`/proc` on Linux, `ps` on macOS, PowerShell on Windows), so a number reused
after a restart is not taken for the owner; where no start time can be read, a lock written
before the computer last started is stale. A stale lock is taken over under a short mutex, so of
two runners that start together, at sign-in and with an opening app, exactly one wins. Turning an
extension off stops it in the runner and frees its lock, so turning it on again starts it; the
runner answers `reload` only after the stops it began have finished, so a removal does not delete
files of a process that is still running. A condition that needs a person (a wider update, a licence to
enter) cannot be asked while no window is open: the runner stops what cannot run, writes the
reason and the app shows it at the next open; it never shows a prompt and never accepts a notice.

**Visibility while Namzu is closed.** An own tray mark is the extension's own and optional: an
extension that draws a tray icon does so itself, and Namzu's tray icon carries nothing an extension
does. One case is required. An extension that runs in the background (`background`) and declares a
permission with `personalData: true` must declare its own tray mark (rule `B2`) and show it while it
records, and its status must say the mark is shown; two statuses in a row without it stop the
extension (`indicator-hidden`) and a restart needs the person. Namzu cannot prove an icon is on the
screen: it requires the claim, inside a signed package, and stops the extension when the claim stops.
Every other extension may declare none. What an extension is doing is written in its row and on its
screen in Settings, Extensions, never on Namzu's tray icon and never in the window's title band.

**The runner is never Namzu's child.** Desktop ends its engine with `taskkill /pid <engine> /t /f` when
it cannot stop it politely, and that walks the whole process tree under the engine; a runner in that
tree would stop with the app and take the recording with it. So on Windows the app starts the runner
through the registered task (`schtasks /run /tn "\Namzu\Extension Runner"`), whose parent is Task
Scheduler, and when there is no task it starts it through `cmd /c start`, whose short-lived `cmd` ends
at once and leaves the runner with no living parent for the walk to follow. On Linux and macOS a
detached start already leaves the process group and the parent. The command lines are checked in unit
tests only; none is run there.

## The extension's own pages

An extension may draw pages inside Namzu: its own HTML, CSS and scripts from the package, in a
slot Namzu offers (a rail entry, a page of the window opened from the extension's screen in Settings). Its
own declared words for a state (the manifest's chip slot) are drawn only in its row and on its screen in
Settings. Desktop draws each page in a sandboxed view of its own; the rules are
in [Extensions in Desktop](desktop-extensions.md#the-extensions-own-pages). The terminal cannot
draw a page: `status` lists them ("Open them in Desktop") and a chip shows as a mark row from its
declared words. What stays Namzu's and can never be drawn by an extension: the install dialog, the
permission list, the notice and acknowledgement, the licence screens and state, Enable, Disable and
Remove, the Start when I sign in switch, the consent record, and the running mark and its
existence.

### Reading another process's state without waiting

When another process (the runner, or another Namzu window) hosts the extension, the host tells that it is still the
owner by comparing the process's start time with the one in its state file. On Windows the system reports a start
time only through a PowerShell call that takes over a second, so the host reads it **once per process and keeps
it**, asks without blocking (a view that needs a start time not yet known is drawn as "not hosted by anyone yet" and
refreshed with a state event when the answer arrives), and forgets it when the process is gone. Opening a page
trusts the process check and the state the host last reported. The strict, blocking read stays where a wrong answer
costs more than a wait: taking over a lock file (`acquireOwnedLock`, `ownerLive`).

The host logs each page open, each page-info call (`ui`) and each query with its duration and outcome
(`namzu.extension.id`, `.call`, `.outcome`, `.duration_ms`); a call over 250 ms is logged as a warning.
