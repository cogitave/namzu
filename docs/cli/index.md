# CLI

* [Scheduled tasks](scheduled-tasks.md) - Prompts that run later in a folder while namzu is closed: jobs, the required permission set, approvals, missed runs, notifications and history.
* [Session loops](session-loops.md) - `/loop` and the session_loop tool: a prompt the open conversation re-sends to itself on an interval, between turns.
* [The scheduler service](scheduler-service.md) - Installing the scheduler under systemd, launchd, Windows Task Scheduler and WSL; single owner, upgrades, status, uninstall.
* [Web search](web-search.md) - Explicit provider-hosted search, source links, and shell-independent activity.
* [Opening a page in your browser](open-url.md) - The open_url tool: which sessions have it, how it reaches the browser on each platform (the Windows browser under WSL), its review, and what its result claims.
* [The browser](browser.md) - The browser the interactive terminal drives: which browser runs where, profiles and `namzu browser login`, the `browser.sites` rules, the review screen, the pause when a page needs you, and what the controls do not stop.

* [Conversation evidence](conversation-evidence.md) - Bounded recovery of retained original tool and assistant output after compaction.
* [Delegated work](delegated-work.md) - Background child sessions, queued corrections, completion, ownership and replay from child logs.

The operator application.

* [Terminal design](terminal-design.md) - Namzu's visual identity, conversation hierarchy and terminal interaction boundaries.
* [Command experience audit](command-experience-audit.md) - Verified command defects, comparison with Codex source, and proposed interaction improvements.
* [Harness efficiency review](harness-efficiency-review.md) - Revision-pinned comparisons, existing strengths and measurable improvements to tool and delegation workflows.
* [Project and session state](project-state.md) - How a working directory maps to projects/<slug>/ under NAMZU_HOME, one active turn per session, and what happens to state an earlier CLI wrote.
* [Session storage](session-storage.md) - Every file the CLI keeps under NAMZU_HOME, the one log per session, the rebuildable index, and which files are safe to delete.
* [Provider credentials and private state](credentials.md) - Existing subscription profiles, credential discovery, the provider list and its credential entry, and Windows and POSIX storage privacy checks.

* [Context and compaction in the CLI](context-and-compaction.md) - The file-only compaction key that picks the kernel's strategy or overrides the model's window, and the /context command that shows what compaction has done in a session.
* [Where the CLI stands against its peers](competitive-gaps.md) - What `Claude Code`, `Codex CLI`, `Gemini CLI` and `OpenCode` offer that namzu does not, what namzu does better, and the backlog that follows.
* [Where tools run](tool-boundary.md) - Host execution under the permission system by default, a path outside the working directory as an approval request, the opt-in sandbox and its per-command escape, and WSL.
* [Adding a directory](add-dir.md) - How a session lets the file tools reach a directory besides the working directory, and what changes for the tools, the sandbox and the model.
* [File checkpoints](file-checkpoints.md) - How the session records every file before a tool changes it, per turn, and how /restore puts the tree back to before a turn.
* [Memory](memory.md) - The curated files injected into every turn, per project and per user, and typed stored memory — one Markdown file per memory, its index in every turn; where each lives and what writes to it.
* [Turn limits](turn-limits.md) - Limits for interactive and headless turns, headless override flags and honest closing stop reasons.
* [Slash commands](slash-commands.md) - Every builtin slash command the interactive session answers to, one line each, with the composer keys that are not commands.
* [Plugins](plugins.md) - Trusted extension loading, live contributions and session enable/disable controls.
* [Skills](skills.md) - Where SKILL.md skills come from and which tier wins a name, how the model is offered them and loads one with the skill tool, which directory it is told a skill's files are in, the manifest budget, tool gating, and the skills config keys.
* [The composer prefixes](composer-prefixes.md) - What a line starting with `!` or `#` does in the composer: a command run on the host without the model, or a note remembered, and what the model learns of either.
* [Background jobs in the CLI](background-jobs.md) - How a command started with run_in_background outlives its turn, what /jobs shows, and how supported sandboxes own detached processes.
* [Resident work in the CLI](resident-work.md) - Durable pursuits, bounded foreground execution, pause observation and inspected recovery.
* [Managed resident runners](resident-runner.md) - Opt-in background hosting, zero-call idle waits, exact-owner status/stop and crash recovery.
* [Tool servers](mcp-servers.md) - The mcpServers config key: a server by command or by URL, the environment its child gets, how long each has to connect, and what happens when one does not.
* [Exit codes of namzu exec](exec-exit-codes.md) - What $? says after namzu exec, including 75 for a turn the provider paused with a checkpoint kept or a session whose turn is still active, and what a wrapper should do with each code.
* [namzu exec --json](exec-json.md) - The headless one-shot as a stream for host UIs: NDJSON events, the session and turn ids they carry, --session history and exit codes.
* [namzu drain](drain.md) - One bounded pass that continues parked turns another process left behind, through the session index and each session's lease.
* [Session task context](task-context.md) - Bounded reminders of a session's open tasks and those closed in the current turn, scope and research boundaries.
* [Google accounts and model access](google.md) - Existing Gemini CLI Google sign-in, explicit API-key routing and read-only credential refresh.
* [The model catalogue refresh](model-catalogue.md) - How every launch refreshes the Zen and Zen Go model catalogue in the background, the last-good copy, what a failure keeps, and the modelCatalogueRefresh key that turns it off.

* [CLI release validation](release-validation.md) - Live terminal acceptance evidence and boundaries for the pending release.

* [Tool-result screens](tool-result-screens.md) - The toolResultScreens config key: which screens judge a tool result before the model reads it, the empty list that turns the default off, and the per-tool `passthroughTools` exception.
