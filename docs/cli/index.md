# CLI

* [Process-local model profiles](model-profiles.md) - Export main, side and delegated model choices, effort, output allowance and automatic-summary window for one process.

* [Pals in the CLI](pals.md) - Saved identities, local guest computers, terminal chat and exact conversation ownership.
* [Command words and help](command-words.md) - How commands are spelled, `namzu help`, help before the Namzu home exists, and the retired spellings with what to type instead.
* [namzu computer](computer.md) - Check, set up and stop the Windows Pal computer, in plain words and as JSON lines for Desktop.
* [Local authenticated Pal channel adapters](pal-channels.md) - Private local fixture verification, shared SDK inboxes and native recorded reply/review-action routing.

* [Sending spans and metrics to a collector](telemetry-export.md) - opt in with NAMZU_ENABLE_TELEMETRY or telemetry.otlp and the CLI sends spans and metrics to an OpenTelemetry collector.
* [Updates](updates.md) - Background updates in the terminal: which installs update themselves, the safety steps, the `updates` keys and environment variables, and `namzu update`.
* [Installing and reopening Namzu](installation.md) - Correct shell commands, installer diagnostics and portable conversation resume handoffs.
* [Code analysis in the terminal](code-analysis.md) - The `code_analysis` tool: cited, paged lookups of a string, its function, source and callers; where its index lives, what it costs, and the `codeAnalysis` key that turns it off.
* [Image generation](image-generation.md) - The `generate_image` tool: create and edit images with the person's subscription plan whichever model leads, when it is offered, where the files go, and the `imageGeneration` key.
* [Auto model routing](auto-model-routing.md) - `model: auto` and the `routing` block: per-task fast, default or big model, sized by the decision model, failing open to `routing.default`.
* [Decision points](decision-points.md) - `decision.points`: yes/no questions the CLI can ask the decision model beside its own rule, in `off`, `shadow` or `on` mode, starting with whether a finished reply is worth a chime.
* [Scheduled tasks](scheduled-tasks.md) - Prompts that run later in a folder while namzu is closed: jobs, the required permission set, approvals, missed runs, notifications and history.
* [Session loops](session-loops.md) - `/loop` and the session_loop tool: a prompt the open conversation re-sends to itself on an interval or at a pace the model picks, between turns, and the timers the model sets.
* [The scheduler service](scheduler-service.md) - Installing the scheduler under systemd, launchd, Windows Task Scheduler and WSL; single owner, upgrades, status, uninstall.
* [Web search](web-search.md) - Explicit provider-hosted search, source links, and shell-independent activity.
* [Opening a page in your browser](open-url.md) - The open_url tool: which sessions have it, how it reaches the browser on each platform (the Windows browser under WSL), its review, and what its result claims.
* [Computer use settings](computer-use-settings.md) - `computerUse.enabled` (off by default, user and managed files only), `computerUse.browserWindows` (look, ask or act in your own browser window) and `computerUse.deniedApps`, where each is checked, and what the Settings rows do.
* [The browser](browser.md) - The browser the interactive terminal drives: which browser runs where, profiles and `namzu browser login`, the `browser.sites` rules, the review screen, the pause when a page needs you, and what the controls do not stop.
* [Print mode and the prompt argument](print-mode.md) - namzu "<prompt>" and namzu -p "<prompt>": the first message of the session, the headless answer that runs namzu exec, which options -p takes, and the print-only options refused without it.
* [Startup time](startup.md) - What loads before the first screen or request, the lazy command list, the compile cache, how `exec` treats piped input, and `scripts/bench-startup.mjs` with reference numbers.

* [Conversation evidence](conversation-evidence.md) - Bounded recovery of retained original tool and assistant output after compaction.
* [Project instructions](project-instructions.md) - Your own file, each directory's AGENTS.md, rule files and the private AGENTS.local.md, the order they apply in, @path includes, conditional rules and what is refused.
* [Notes the model reads as a turn goes](turn-notes.md) - The quiet-stretch nudge and its `progressNudge` key, the time line on a message, and the clauses some tool results carry.
* [Plan mode](plan-mode.md) - The plan file, the exit_plan_mode tool and its approval box, the mode the approval switches to, and the hidden reminders (plan mode's and the task-list nudge).
* [Delegated work](delegated-work.md) - Background child sessions, queued corrections, completion, ownership and replay from child logs.
* [Workflows in the CLI](workflows.md) - The workflow tool: when the model is offered it, the review before it starts, how its agents run and appear, how to stop or skip, and what the model is told when it ends.

The operator application.

* [Vim keys in the message box](composer-vim.md) - `/vim` and `tui.editorMode`: INSERT, NORMAL, VISUAL and VISUAL LINE in the message box, where the mode is shown, what Esc and Enter do in each, the motions, operators, text objects, register and dot repeat that are built, and what is left out.
* [Themes and reduced motion](themes.md) - The seven theme choices, how auto decides, the /theme picker with preview, the tui.theme and tui.reducedMotion keys and what reduced motion turns off.
* [Terminal design](terminal-design.md) - Namzu's visual identity, conversation hierarchy and terminal interaction boundaries.
* [Command experience audit](command-experience-audit.md) - Verified command defects, comparison with Codex source, and proposed interaction improvements.
* [Harness efficiency review](harness-efficiency-review.md) - Revision-pinned comparisons, existing strengths and measurable improvements to tool and delegation workflows.
* [Project and session state](project-state.md) - How a working directory maps to projects/<slug>/ under NAMZU_HOME, one active turn per session, and what happens to state an earlier CLI wrote.
* [GitHub workflows and pull request links](github.md) - namzu github install writes Actions workflows that answer @namzu mentions and review new pull requests; conversations that open a pull request are linked to it and --from-pr lists them.
* [Managed Git worktrees](worktrees.md) - Create separate checkouts, fork a settled conversation into one, and reopen its project.
* [Session storage](session-storage.md) - Every file the CLI keeps under NAMZU_HOME, the one log per session, the rebuildable index, and which files are safe to delete.
* [Watching a session from another terminal](watching-a-session.md) - `namzu watch` and `namzu send`: follow a running or finished session from a second terminal, say something to it as yourself, what each can and cannot do, states and exit statuses.
* [Messages between live terminals](peer-messaging.md) - Discover independent terminals on this computer and send attributed context at safe request boundaries, from a terminal or with `namzu peers`.
* [Teammates](teams.md) - How teammates are turned on (the teams.enabled setting, NAMZU_TEAMS and --teams), how a teammate's permission asks and plans reach you, its hook events, the team on the terminal (rows, transcript, stop, /team, the task list), the limits that apply, and where they do not run.
* [Your Namzu network](namzu-network.md) - See your other machines and their sessions, message them, give them roles, and let a new machine join with one Allow.
* [Accounts in the terminal](accounts.md) - `/auth` and `--account`: choose the account a conversation uses, add a Codex sign-in or labelled API key, and what happens when an account runs out of allowance.
* [namzu auth](auth.md) - `namzu auth login`, `logout` and `status`: sign in or out, and list stored or detected credentials as usable or expired, never printing a secret.
* [namzu state purge](state-purge.md) - Delete what Namzu keeps in its home for one project or all of them: what is listed, how it asks, and what it refuses.
* [Provider credentials and private state](credentials.md) - Existing subscription profiles, credential discovery, the provider list and its credential entry, and Windows and POSIX storage privacy checks.
* [Native conversation engines](native-engines.md) - Installed native execution, engine catalogues, exact durable continuation, live reviews and confirmed shutdown.

* [Context and compaction in the CLI](context-and-compaction.md) - The file-only compaction key that picks the kernel's strategy or overrides the model's window, and the /context command that shows what compaction has done in a session.
* [Where the CLI stands against its peers](competitive-gaps.md) - What `Claude Code`, `Codex CLI`, `Gemini CLI` and `OpenCode` offer that namzu does not, what namzu does better, and the backlog that follows.
* [Where tools run](tool-boundary.md) - Host execution under the permission system by default, a path outside the working directory as an approval request, the opt-in sandbox and its per-command escape, and WSL.
* [Permission modes](permission-modes.md) - The six modes (prompt, accept-edits, plan, bypass, auto, strict), the flags and Shift+Tab that reach them, what bypass and auto still ask, the `permissions.defaultMode`, `disableBypassMode`, `disableAutoMode` and `autoMode` settings, and how the auto classifier picks its model.
* [Permission layers and remembered answers](permission-layers.md) - How the permissions tables of the config layers combine (a deny from any layer wins), where "don't ask again" is written, and which shell commands run without a prompt.
* [Launch flags](launch-flags.md) - `--provider`, `--model`, `--effort` and `--permission-mode` on the interactive session: session-only, how they combine with the saved choice and `--dangerously-skip-permissions`, and what happens when one cannot be honoured.
* [Flags for one run](run-flags.md) - `--append-system-prompt`, `--allowed-tools`, `--disallowed-tools`, `--fallback-model` and `--max-budget-usd`: where each goes, how each combines with the config, and what a bad value does.
* [Proxies and certificates](network.md) - `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` for providers, tool servers and the web tools, `NODE_EXTRA_CA_CERTS`, a client certificate, the doctor row, and what the setting does not reach.
* [Adding a directory](add-dir.md) - How a session lets the file tools reach a directory besides the working directory, and what changes for the tools, the sandbox and the model.
* [File checkpoints](file-checkpoints.md) - How the session records every file before a tool changes it, per turn, and how /restore puts the tree back to before a turn.
* [Turn undo](turn-undo.md) - The durable, turn-keyed file history behind undo and /restore, and the plan that decides what undoing a turn may write.
* [Memory](memory.md) - The curated files injected into every turn, per project and per user, and typed stored memory — one Markdown file per memory, its index in every turn; where each lives and what writes to it.
* [namzu eval](eval.md) - Run eval suites with repeats and a seed, read a report's intervals and disclosure, and compare two reports paired by case.
* [Turn limits](turn-limits.md) - Limits for interactive and headless turns, headless override flags and honest closing stop reasons.
* [Slash commands](slash-commands.md) - Every builtin slash command the interactive session answers to, one line each, with the composer keys that are not commands.
* [Plugins](plugins.md) - Trusted extension loading, live contributions and session enable/disable controls.
* [Installed plugins](plugin-records.md) - The install records, the settings that turn an installed plugin on, how it meets discovery and trust, and `namzu plugin list`, `details`, `enable` and `disable`.
* [Install plugins](plugin-install.md) - `namzu plugin install`, `update`, `uninstall`, `prune` and `marketplace add`, `list`, `remove` for folders, archives and marketplaces: the preview of everything a plugin runs, the digest you accept, scopes, exit codes and what a crash leaves behind.
* [Marketplaces and downloads](plugin-marketplaces.md) - `namzu plugin marketplace add` from a repository or an https address, `marketplace update`, how an address is read, the safe way Git and downloads are run, entry sources and pins, `--ref` and `--sparse`, the block list and `plugin update` with the change in what runs.
* [namzu plugin validate](plugin-validate.md) - Check a plugin folder and every part it carries without running anything from it: problems with file and line, the codes, the JSON shape and the exit statuses.
* [Skills](skills.md) - Where SKILL.md skills come from and which tier wins a name, how the model is offered them and loads one with the skill tool, which directory it is told a skill's files are in, the manifest budget, tool gating, and the skills config keys.
* [namzu skills add, create and remove](skills-add.md) - Add skills from a zip, .skill, .md or folder, write one from flags and remove one: the checks, what is asked before a skill that can run commands, backups, the provenance file, the JSON shapes and the exit statuses.
* [Where files go](where-files-go.md) - The two-line standing guidance on where a session puts what it creates, and the home-folder startup line.
* [The composer prefixes](composer-prefixes.md) - What a line starting with `!` or `#` does in the composer: a command run on the host without the model, or a note remembered, and what the model learns of either.
* [Composer triggers](composer-triggers.md) - Words in a message that name one namzu action for it — the hypermode keyword, save-as-skill phrases in English and Turkish — how they are matched and shown, Alt+W, what they change about the turn, and the composerTriggers key that turns them off.
* [Custom status line](status-line.md) - The statusLine key: a command whose output is drawn above the footer, the JSON it reads on stdin, when it runs, where it may be set, and what an empty or failed run shows.
* [Background jobs in the CLI](background-jobs.md) - How a command started with run_in_background outlives its turn, what /tasks shows, and how supported sandboxes own detached processes.
* [Monitors in the CLI](monitor.md) - How the monitor tool is mounted, how its events wake an idle session or a single-shot run, and how monitors are counted and listed.
* [Learning in the CLI](learning.md) - namzu learn and namzu learning, the failures conversations keep as observations, the built-in generator that learns from them by itself, where and how long, and the learningObservations and learningGenerator keys.
* [Tool servers](mcp-servers.md) - The mcpServers config key: a server by command or by URL, the environment its child gets, how long each has to connect, and what happens when one does not.
* [Exit codes of namzu exec](exec-exit-codes.md) - What $? says after namzu exec, including 75 for a turn the provider paused with a checkpoint kept or a session whose turn is still active, and what a wrapper should do with each code.
* [namzu exec --json](exec-json.md) - The headless one-shot as a stream for host UIs: NDJSON events, the session and turn ids they carry, --session history and exit codes.
* [Usage limits in Desktop](usage-limits.md) - What the usage limits popover shows per provider, where each number comes from, how often a vendor is asked, and what is kept (nothing).
* [Spend by day and model](cost.md) - What conversations on this machine cost by local day, model, project and kind of work, from the session logs: /cost days, namzu cost and its JSON shape, how unknown prices are shown, and the rebuildable summary it reads through.
* [namzu drain](drain.md) - One bounded pass that continues parked turns another process left behind, through the session index and each session's lease.
* [Session task context](task-context.md) - Bounded reminders of a session's open tasks and those closed in the current turn, scope and research boundaries.
* [Google accounts and model access](google.md) - Existing Gemini CLI Google sign-in, explicit API-key routing and read-only credential refresh.
* [The model catalogue refresh](model-catalogue.md) - How every launch refreshes the Zen and Zen Go model catalogue in the background, the last-good copy, what a failure keeps, and the modelCatalogueRefresh key that turns it off.
* [When a model declines to answer](model-refusal.md) - What the terminal and namzu exec say when a model declines a message, the one automatic retry on another model and that model kept for the conversation, and the refusalFallback key that turns the swap off.
* [The small model for side jobs](small-model.md) - The smallModel key and how a side job picks its model, conversation titles written by it, the answer web_fetch extracts, and why it never blocks or fails a turn and is counted on the turn's ledger.

* [CLI release validation](release-validation.md) - Live terminal acceptance evidence and boundaries for the pending release.

* [Tool-result screens](tool-result-screens.md) - The toolResultScreens config key: which screens judge a tool result before the model reads it, the empty list that turns the default off, and the per-tool `passthroughTools` exception.

* [Desktop application](desktop.md) - Native operator workspace using the existing CLI runtime and conversation logs, with terminal tabs and an engine's own command line beside the conversations.
* [Desktop engine bundles](desktop-engine-bundles.md) - For maintainers: how the engine Desktop keeps current by itself is staged, packed, described, signed and published; the file formats, the publisher commands, the release workflow, and how keys are added, retired, lost or leaked.
* [namzu config](config-command.md) - List, read, set and unset every described setting from the terminal or with /config <key>, reading the same description as Desktop Settings so values are accepted, refused and confirmed with the same words.
* [What Desktop keeps across a restart](desktop-state.md) - One owner for each fact: the session log for a conversation's own facts, one main-process store for window and interface state, how a quit differs from a crash, and what is never kept.
* [Desktop settings for config keys](desktop-settings.md) - Every config key in Desktop Settings from one engine-owned list: sections, validated writes to the user file, confirmations, and what is never shown.
* [Desktop sizes standard](desktop-ui-sizes.md) - Text roles, icon sizes per container, control heights and where an accent fill is allowed in Desktop, and the tests that keep them.
* [Desktop voice input](desktop-listening.md) - Talking to Namzu Desktop in Turkish: the on-device recognition engine, microphone capture and consent, endpointing and stop words, read-aloud and barge-in, and what stays on the computer.
* [Desktop engine updates](desktop-engine-updates.md) - How Namzu Desktop keeps its engine current by itself from a signed description and an archive, what it checks first, the screens and the setting, and what is and is not protected; on in a packaged app, off in an app that is not packaged unless it is given a feed address.
* [CLI ACP live input](acp.md) - Owned live operator messages, bounded receipt reconciliation and safe delegation wait release.
* [namzu workspaces (preview)](workspaces.md) - Workspaces (project folders) with tabs and tiled panes of live sessions in one terminal, opened with `←` from a conversation or by the command: status dots, panes and tabs, keys, mouse, the tab bar, theme colours, starting a session on an account, the remembered layout, the navigate-key setting, a session that stops, and the plain fallback.
* [Pasting images into the composer](clipboard-and-images.md) - Which key pastes an image on each platform, how WSL reaches the Windows clipboard, what a paste of file paths does, and what each message means.
* [Goals](goals.md) - `/goal`: how a goal continues, what stops it (no progress, the same failure, an optional check-in (off by default), a token budget, a backstop), how a completion report is checked with evidence, and ending it by the record of the work, with the `goal.*` settings, `--token-budget`, `--max-rounds` and `--confirmed-by`.
* [The setting description](setting-description.md) - The one typed description every setting has: its default, plain-worded choices and when a change applies; who reads it and the guard that keeps it complete.
* [Settings tools for the model](agent-settings-tools.md) - get_settings and set_setting, the deferred tools that let the model read the safe settings and change one with your yes on a card: the allow-list, what is refused, who decides a value, and the Let Namzu change settings switch.
* [Extensions](extensions.md) - Separate programs added from a signed file: what `namzu extension` does, the notice you acknowledge once, updates that ask for more, the licence key, what the host refuses at run time and how a running extension says so.
* [Extension manifest](extension-manifest.md) - The namzu-extension.json a package carries: permissions with a purpose each, data and retention, languages, the process entry, licensing and signing, and the fields refused in this version.
* [Customize in Desktop](desktop-customize.md) - the Customize page: Skills, Connectors and Plugins, a skill's detail with Overview and Contents, a plugin's detail, the connectors table, the ways in, and the host methods behind it.
* [Record your screen in Desktop](desktop-record-your-screen.md) - Windows only: a recording of pictures, the controls you use, ordinary text and optional voice kept in memory, the chooser and pill, the limits, the review sheet, how it becomes a message and a skill through the save card, the Privacy settings and the antivirus note.
* [Extensions in Desktop](desktop-extensions.md) - Settings, Extensions: one row for each extension and its own screen, the notice screen, What is collected, the pages an extension draws in the main pane, where its tray mark belongs and the namzu/extensions methods.
* [Releasing by hand](releasing.md) - `pnpm release local` and `pnpm release desktop`: the checks, the gate record, signing in to npm, dry runs, the Windows packaging step and the feed upload.
