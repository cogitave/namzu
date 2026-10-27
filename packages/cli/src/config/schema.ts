/**
 * Public @namzu/cli configuration vocabulary.
 *
 * Runtime admission lives in `load.ts`, beside the source/precedence facts it
 * needs for actionable errors. Keeping this file declarative makes the public
 * type the one list of settings while the loader's total reader map forces a
 * validation decision whenever that list grows.
 */

import type { ShellHookEntry, ShellHookEvent, ShellHooksConfig } from '@namzu/sdk'
import type { McpServersConfig } from '../integrations/mcp/servers.js'
import type { FormatName } from '../output/index.js'
import type { BrowserSitesConfig } from '../permissions/browser-sites.js'
import type { PermissionChecksConfig } from '../permissions/checks.js'
import type { PermissionsConfig } from '../permissions/rules.js'
import type { PermissionSettings } from '../permissions/settings.js'
import type { ThemeSetting } from '../tui/theme-palettes.js'
import type { ToolResultScreenConfig } from './tool-result-screens.js'

/**
 * What one profile may set.
 *
 * Executable plugins are intentionally excluded as well as nested profiles:
 * `NAMZU_PROFILE` may select a declared profile, and ambient shell state must
 * not be able to turn code loading on.
 */
export type ProfileConfig = Omit<NamzuCliConfig, 'profiles' | 'plugins'>

export type ProfilesConfig = Readonly<Record<string, ProfileConfig>>

/** The two operator-visible moments the TUI can notify about. */
export type TerminalNotificationEvent = 'turn-settled' | 'approval-required' | 'idle-prompt'

/** Escape protocol used for an opted-in terminal notification. */
export type TerminalNotificationMethod = 'osc9' | 'bel' | 'kitty' | 'ghostty'

export interface TuiConfig {
	/**
	 * Notify for TUI events through the terminal itself.
	 *
	 * Absent or `false` means off. `true` enables `turn-settled` and
	 * `approval-required`; a list enables only the named events (`idle-prompt`,
	 * the "waiting for your input" notice after a minute of quiet, is asked for
	 * by name), and an empty list explicitly disables all of them.
	 * No command is started and no conversation content is included.
	 */
	readonly notifications?: boolean | readonly TerminalNotificationEvent[]
	/** Terminal protocol to write. Defaults to `osc9` when notifications are on. */
	readonly notificationMethod?: TerminalNotificationMethod
	/**
	 * The colours the terminal UI is drawn in: `auto` (follow the terminal's
	 * light or dark background), `dark`, `light`, `dark-daltonized`,
	 * `light-daltonized`, `dark-ansi` or `light-ansi`. Absent means `dark`.
	 * Taken from your own config files only: a project file cannot restyle
	 * your terminal, so it is ignored there. `/theme` sets it.
	 */
	readonly theme?: ThemeSetting
	/**
	 * Turn off the working line's moving highlight and the composer's pulse.
	 * Absent or `false` means motion is on. Your own config files only.
	 */
	readonly reducedMotion?: boolean
	/**
	 * The one-line recap shown when a person returns to the terminal after a few
	 * minutes away. Absent or `true` means on; only `false` turns it off. The
	 * `NAMZU_RECAP` variable overrides this either way.
	 */
	readonly recap?: boolean
	/**
	 * Show one dim tip under the working row while a reply runs. Default
	 * `true`; only an explicit `false` turns it off. The `Next:` row (the
	 * plan's next task) is not a tip and shows either way.
	 */
	readonly spinnerTips?: boolean
}

/** Where the CLI may discover executable plugin bundles. */
export type PluginScope = 'project' | 'user'

/**
 * Shell hooks are the kernel's contract (`@namzu/sdk` `plugin/shell-hook`);
 * the config file carries its shape and nothing more. Aliased here so the
 * loader and the session option name the same types the kernel exports.
 */
export type HookEvent = ShellHookEvent
export type HookEntry = ShellHookEntry
export type HooksConfig = ShellHooksConfig

/** See `NamzuCliConfig.limits`. */
export interface TurnLimitsConfig {
	/** Main-loop iterations one turn may make. Omitted or 0 means unlimited. */
	readonly maxIterations?: number
	/** Aggregate prompt and completion tokens for the turn and descendants. Omitted or 0 means unlimited. */
	readonly tokenBudget?: number
	/** Total turn duration in milliseconds. Omitted or 0 means unlimited. */
	readonly timeoutMs?: number
	/**
	 * Milliseconds a headless `namzu exec` may spend waiting out provider
	 * pauses — a rate limit, an outage — resuming from its checkpoint after
	 * each, before it stops with exit code 75. Default 0: a pause ends it at once.
	 */
	readonly waitForProviderMs?: number
}

/** See `NamzuCliConfig.workflow`. */
export interface WorkflowCliConfig {
	/** Agents one workflow runs at once. Default `min(16, CPUs - 2)`, at least 2; at most 16. */
	readonly maxConcurrency?: number
	/** Agents one workflow run may start. Default 1000; at most 1000. */
	readonly maxAgents?: number
	/**
	 * How big a workflow the model is advised to write: `small` (under 5 agents),
	 * `medium` (under 10, the default), `large` (under 50) or `unrestricted`
	 * (no advice). A guideline, not a limit. Also sets when the rail warns of a
	 * large run.
	 */
	readonly sizeGuideline?: 'unrestricted' | 'small' | 'medium' | 'large'
}

/** See `NamzuCliConfig.compaction`. */
export interface CompactionCliConfig {
	/** Bounded historical evidence recall in recorded conversations. Default true; false disables it. */
	readonly recallEvidence?: boolean
	/** Resolve follow-up search references with a metered model call when recall is enabled. Default true. */
	readonly resolveEvidenceQueries?: boolean
	/** Retained overflow preview in recorded conversations; default 4,000 chars. 0 keeps the ordinary 40,000-char budget. */
	readonly retainedToolPreviewChars?: number
	/** Mask exact repeated read-only observations in model requests; enabled unless false. */
	readonly deduplicateObservations?: boolean
	/**
	 * Which context-management strategy the kernel runs. `salience` is the
	 * default: every message scored, the context held near half the window
	 * (see the SDK's compaction module). `structured` is the previous
	 * behaviour — positional retention, a pass only at the trigger.
	 */
	readonly strategy?: 'structured' | 'salience'
	/**
	 * The model's context window, in tokens, when the kernel's table for the
	 * model is wrong or a project wants compaction to run earlier than the
	 * real window would make it. Absent means the kernel resolves it from
	 * the model, which is right for almost every project.
	 */
	readonly contextWindowTokens?: number
	/**
	 * Use consolidation (one `learning` entry) instead of the default
	 * extracted-claim promoter when the turn ends. Both write to the project's
	 * memory store. This selects the writer; `memory.recall` controls retrieval.
	 */
	readonly consolidate?: boolean
	/**
	 * Compact a large conversation nobody is using just before its one-hour
	 * prompt cache expires, so coming back does not re-write the whole context.
	 * Default `false`. Acts only with `promptCacheTtl: '1h'` on a provider that
	 * reports the cache lifetime; never on one that does not.
	 */
	readonly idleCompaction?: boolean
	/**
	 * The smallest context, in tokens, worth compacting while idle. Default
	 * 200,000; values under 100,000 are raised to 100,000. The environment
	 * variable `NAMZU_IDLE_COMPACT_MIN_TOKENS` overrides it.
	 */
	readonly idleCompactionMinTokens?: number
	/**
	 * How long the provider keeps the prompt cache: `'5m'` (default, the
	 * provider's own) or `'1h'`. Passed to providers that can be asked
	 * (not every provider can be asked). A one-hour cache costs more per write.
	 */
	readonly promptCacheTtl?: '5m' | '1h'
}

/** See `NamzuCliConfig.browser`. */
export interface BrowserConfig {
	/**
	 * Mount the browser tools in the interactive terminal. Default `true`.
	 * `exec`, `exec --json`, `drain` and `acp` never mount them; a scheduled
	 * job gets them only through its own grant.
	 */
	readonly enabled?: boolean
	/**
	 * The profile the TUI starts on (`default` when absent). A profile holds
	 * the sites' sign-ins, so a project file may not choose it.
	 */
	readonly defaultProfile?: string
	/** `auto` (default) follows the machine; `windows` forces the Windows browser from WSL; `local` a browser this process launches. */
	readonly engine?: 'auto' | 'windows' | 'local'
	/** `auto` (default) shows a window when there is a display; `always` never does; `never` always does. */
	readonly headless?: 'auto' | 'always' | 'never'
	/** Site key to level (`deny`, `read`, `ask`, `act`); `*` is every other site, `ask` when absent. */
	readonly sites?: BrowserSitesConfig
	/** Leave the browser running when the session ends. Default `false`. */
	readonly keepOpen?: boolean
}

/** See `NamzuCliConfig.codeAnalysis`. */
export interface CodeAnalysisConfig {
	/** Mount the `code_analysis` tool in the interactive terminal. Default `true`. */
	readonly enabled?: boolean
}

/** See `NamzuCliConfig.web`. */
export interface WebConfig {
	/** Web search is live by default. Set off to disable it. */
	readonly search?: 'off' | 'cached' | 'live'
	/** Auto prefers declared native support, otherwise Exa. Explicit choices never silently switch. */
	readonly backend?: 'auto' | 'exa' | 'native'
	/**
	 * Mount `web_fetch` over the guarded provider. Default `true`; each new domain is
	 * asked once. `false` removes the tool.
	 */
	readonly fetch?: boolean
}

export interface MemoryCliConfig {
	/** Recall bounded active project records before each model step. Default true. */
	readonly recall?: boolean
	/** Ground automatic recall in mixed letter/digit identifiers when present. Default false. */
	readonly identifierGrounding?: boolean
}

/**
 * Session plugin runtime settings.
 *
 * Plugins may import JavaScript hooks and tools, so the runtime is disabled
 * unless an operator opts in explicitly. Project plugins are considered only
 * after the existing project trust gate has pinned the canonical cwd.
 */
export interface PluginConfig {
	/** Start the plugin runtime. Only the exact value `true` enables it. */
	readonly enabled?: boolean
	/** Scan admitted plugin directories. Defaults to `true` once enabled. */
	readonly autoDiscovery?: boolean
	/** Locations the discovery pass may read. Defaults to project and user. */
	readonly allowedScopes?: readonly PluginScope[]
	/** Per-hook deadline in milliseconds. Defaults to the SDK runtime default. */
	readonly hookTimeoutMs?: number
}

export interface NamzuCliConfig {
	/** Default output format when not overridden by --format. */
	readonly format?: FormatName
	/** Default quiet mode. */
	readonly quiet?: boolean
	/**
	 * Which tools may run without asking, keyed by tool name.
	 *
	 * A value is `"allow" | "ask" | "deny"`, or a table of argument patterns
	 * mapping to those. Absent means every mutating tool prompts, which is what
	 * it meant before this existed — the absence of a policy never widens one.
	 */
	readonly permissions?: PermissionsConfig
	/**
	 * The `permissions` tables of the layers that set one, lowest precedence
	 * first (user, project, local, profile, managed). Filled in by the loader
	 * and never read from a file: `permissions` above is their combined view,
	 * and a call is decided layer by layer, a deny from any layer winning
	 * (`compilePermissionLayers`).
	 */
	readonly permissionLayers?: readonly PermissionsConfig[]
	/**
	 * The mode settings written beside the tool rules in the `permissions`
	 * table (`defaultMode`, `disableBypassMode`, `disableAutoMode`, `autoMode`),
	 * lifted out and combined by the loader with each file's authority applied:
	 * a project file cannot make `bypass` or `auto` the default. Never read from
	 * a file as a key of its own.
	 */
	readonly permissionSettings?: PermissionSettings
	/**
	 * What the operator believes the table above decides, checked at startup.
	 *
	 * Each entry names a tool, an input, and the expected `"allow" | "ask" |
	 * "deny"`. A mismatch is reported by index and the turn continues — the
	 * point is to say that a policy does not do what its author said, which
	 * a table of globs cannot be read for. Absent means nothing is checked,
	 * which is what it meant before this existed.
	 */
	readonly permissionChecks?: PermissionChecksConfig
	/**
	 * Named bundles of settings to switch between.
	 *
	 * A profile is not another file. It sits INSIDE one, so the settings a
	 * person switches between live next to each other and can be read as a
	 * set — which is the thing a second config file cannot give you, because
	 * a second file has to be found before it can be compared.
	 *
	 * Selecting one applies it as a layer above the file it came from, so a
	 * profile overrides that file's own base values and is in turn overridden
	 * by the environment. A profile may set anything except `profiles` and
	 * executable `plugins`: a
	 * profile that carried profiles would be a cascade inside a cascade, and
	 * the question "which one is active" would stop having one answer.
	 * Plugins are excluded because `NAMZU_PROFILE` can select a profile; shell
	 * state must not be an executable-code authority.
	 */
	readonly profiles?: ProfilesConfig
	/**
	 * External tool servers to connect, keyed by the name their tools are
	 * prefixed with.
	 *
	 * Each entry names either a `command` to run or a `url` to reach. Absent
	 * means no external servers, which is what it meant before this existed.
	 */
	readonly mcpServers?: McpServersConfig
	/** Executable extension bundles. Absent keeps discovery and imports off. */
	readonly plugins?: PluginConfig
	/**
	 * How far one turn may go before the kernel stops it. Headless `exec` and
	 * `exec --json` read these; `--max-iterations` and `--token-budget` override
	 * them for one turn. Absent means unlimited tokens, iterations and turn duration.
	 * Explicit token budgets cover descendants.
	 */
	readonly limits?: TurnLimitsConfig
	/**
	 * Caps for the `workflow` tool's runs: how many of a run's agents go at once
	 * and how many it may start in all. Absent keeps the defaults. The review
	 * shows the values in force.
	 */
	readonly workflow?: WorkflowCliConfig
	/**
	 * Isolation for the commands this CLI runs.
	 *
	 * Absent means ON. That is a change from every version before this one,
	 * where `sandboxProvider` appeared nowhere in this package and every
	 * tool call ran in the host process with the host environment — the
	 * isolation the documentation described held on no path at all.
	 *
	 * Named `sandbox` rather than `isolation` because the thing being
	 * configured is the sandbox; what it enforces is `requireIsolation`
	 * inside it, and collapsing the two would make "turn isolation off"
	 * ambiguous between "no sandbox" and "a sandbox that requires nothing".
	 */
	readonly sandbox?: SandboxConfig
	/**
	 * Whether the agent may reach the web, and how.
	 *
	 * Search defaults to automatic native/Exa routing; set `search: off`
	 * to disable it. Queries are sent only when the tool runs, subject to
	 * normal network-tool review. `backend: native` selects provider-hosted
	 * search instead, without local-tool review. `fetch: true` separately
	 * mounts guarded URL fetching; fetch remains off by default.
	 */
	readonly web?: WebConfig
	/**
	 * The browser the interactive terminal drives (`browser` and
	 * `browser_act`), and which sites it may open and change.
	 *
	 * Merged across files key by key, and a site any file denies stays
	 * denied: a project can add sites and narrow them, never reopen one a
	 * user or managed file closed, and cannot switch the browser on when a
	 * file above it switched it off. Not settable from the environment.
	 */
	readonly browser?: BrowserConfig
	/**
	 * The `code_analysis` tool in the interactive terminal: cited, paged
	 * lookups over an index of the project's JavaScript and TypeScript (a
	 * string literal, the function around it, its source, its callers).
	 *
	 * On by default. `{ "enabled": false }` removes the tool from the session
	 * and the index is never built. Merged across files: `enabled: false` in
	 * any file holds, and a later file cannot switch it back on. Not settable
	 * from the environment. `exec`, `drain` and `acp` never mount it.
	 */
	readonly codeAnalysis?: CodeAnalysisConfig
	/**
	 * A System-1 decision model. When set, the host and Pal agents get an
	 * optional, advisory `decide` tool (yes/no, choice or score). A failing
	 * model never fails a turn: the tool reports it unavailable and the
	 * agent proceeds. Absent means the tool is not mounted.
	 *
	 * Accepted only from the user and managed config layers, never a project's
	 * `namzu.config.json` or the environment: it names a network endpoint and
	 * the env var holding a bearer token, so where decisions go and which
	 * credential pays for them is the operator's call, not the workspace's.
	 */
	readonly decision?: DecisionConfig
	/**
	 * `auto` lets the host pick, per task, which configured model runs it (see
	 * `routing`). Absent keeps today's behaviour: the saved provider and model
	 * run every turn. A model pinned for the launch (`--model`) or the session
	 * (`/model`) always wins over `auto`.
	 *
	 * `auto` needs `routing.default`, checked when the config loads. Accepted
	 * only from the user and managed config layers, like `routing`.
	 */
	readonly model?: 'auto'
	/**
	 * Tiers and thresholds for `model: auto`. A task is sized by the `decision`
	 * model and run on the `fast`, `default` or `big` tier; any failure to
	 * decide runs it on `routing.default`, never on `fast` or `big`.
	 *
	 * Accepted only from the user and managed config layers, never a project's
	 * `namzu.config.json` or the environment: it chooses which provider and
	 * model receive the conversation, which is the operator's call.
	 */
	readonly routing?: RoutingConfig
	/**
	 * The model for side jobs: a short conversation title, and the answer
	 * `web_fetch` extracts from a page. `provider/model` names one explicitly
	 * (for example `acme/small-chat`); a bare model id means that
	 * model at the provider the conversation runs on.
	 *
	 * Absent, a side job uses the cheapest priced text model the active
	 * provider lists, and the conversation's own model when none can be
	 * determined. A side job never blocks or fails a turn, and its tokens are
	 * counted on the turn's ledger. Accepted only from the user and managed
	 * config layers: it chooses where conversation text is sent.
	 */
	readonly smallModel?: string
	/**
	 * Shell commands to run at points in the agent's loop: before or after a
	 * tool call, when a turn starts or ends. File-only, never from the
	 * environment — a hook runs a command with the operator's authority, and
	 * a shell profile must not be able to plant one. Exit `2` from a
	 * `pre_tool_use` hook blocks the call and tells the model why; any other
	 * failure is reported and never blocks. The contract is the kernel's
	 * (`@namzu/sdk` `plugin/shell-hook`); this key is only where it is read.
	 */
	readonly hooks?: HooksConfig
	/**
	 * Directories besides the working directory the file tools may reach,
	 * relative to the project or absolute. Bound read-write into the sandbox.
	 * `--add-dir` and `/add-dir` add to this list for one launch or session.
	 */
	readonly additionalDirectories?: readonly string[]
	/**
	 * Screens to run against every tool result, by name.
	 *
	 * Absent runs the kernel's default: a result FRAMED as untrusted — a
	 * connected server's answer, or any tool that marked its own answer that
	 * way — that restates the request is refused before the model reads it.
	 * That default is deliberately narrow: this process's own unframed tools
	 * are left alone, because a tool whose answer is what it was handed is a
	 * working tool, and `web_fetch` returning a page whose body is its own URL
	 * is the case that named the rule.
	 *
	 * An empty list runs none, which is how an operator turns the default off.
	 * `correspondence` and `injection` are the names; see
	 * `config/tool-result-screens.ts`, which is the one place a name becomes a
	 * screen.
	 *
	 * An entry may also be written as an object — `{ "name":
	 * "correspondence", "passthroughTools": [...] }` — carrying that screen's
	 * options. `passthroughTools` names the tools whose answer IS the request
	 * and which must not be refused for saying so; it is the difference
	 * between a screen an operator keeps and one they switch off.
	 */
	readonly toolResultScreens?: readonly ToolResultScreenConfig[]
	/**
	 * How the kernel keeps a long conversation inside the model's window.
	 * File-only: a strategy is a property of a project's runs, not of a
	 * shell. Absent means the kernel's `salience` strategy.
	 */
	readonly compaction?: CompactionCliConfig
	/** Automatic project-memory recall; explicit curated notes are separate. */
	readonly memory?: MemoryCliConfig
	/**
	 * Observability this CLI turns on for itself.
	 *
	 * Absent means none, which is what it meant before this existed —
	 * `sessionExport` in particular sends conversation content off the
	 * machine, so it is a thing an operator asks for by name and never
	 * something a default arranges.
	 */
	readonly telemetry?: TelemetryConfig
	/** Interactive-terminal-only behaviour. Absent leaves notifications off. */
	readonly tui?: TuiConfig
	/**
	 * Refresh provider model catalogues in the background on every launch.
	 *
	 * Today this is the Zen and Zen Go catalogue. Absent or `true` means on: the
	 * interactive TUI, `resume`, `exec` and `acp` start one refresh
	 * that never delays startup, gives up after 30 seconds, and is cancelled when
	 * the command ends. A refresh that lands becomes the catalogue the session
	 * lists and routes with and is kept under the application home as the
	 * last-good copy; one that fails keeps the last-good copy, or the bundled
	 * snapshot, and logs one line. `false` turns it off entirely — no network
	 * read, and no last-good copy either: the bundled snapshot alone. Read
	 * before a project is trusted, so a project file does not affect it.
	 */
	readonly modelCatalogueRefresh?: boolean
	/**
	 * Start with hypermode on. Absent or `false` means off. The interactive
	 * terminal starts every conversation with the mode on (`/hypermode off`
	 * ends it for that conversation; the file is never rewritten), and `exec`,
	 * `exec --json` and scheduled runs tell the model it is on, so a headless
	 * turn gets the same standing instruction to use workflows or, where a run
	 * cannot start one, parallel agents. Hypermode never changes the reasoning
	 * effort. File only: no environment variable sets it.
	 */
	readonly hypermode?: boolean
	/**
	 * Keep what a conversation already classifies as a failure or an unrecovered
	 * stop (a failed tool call, a provider error, a turn that ended early) as a
	 * learning observation, so `namzu learn` has real input. Absent means on;
	 * `false` records nothing. What is kept is a reference to the conversation
	 * and turn plus one short redacted sentence, in the project's own state
	 * directory, never uploaded, and dropped after 30 days. Read by the
	 * interactive terminal and `exec`.
	 */
	readonly learningObservations?: boolean
	/**
	 * Whether Namzu learns from what conversations kept, by itself, in the
	 * background of the interactive terminal. Absent means on. `false` turns
	 * it off; a mapping sets `enabled` and the token caps for one cycle
	 * (`cycleTokens`, default 120,000) and for one day (`dailyTokens`, default
	 * 300,000). A project file can only lower these, never raise them or turn
	 * learning back on. Not settable from the environment.
	 */
	readonly learningGenerator?:
		| boolean
		| {
				readonly enabled?: boolean
				readonly cycleTokens?: number
				readonly dailyTokens?: number
		  }
	/**
	 * The scheduler (`namzu schedule`). Read from the user and managed files
	 * only: a project file is repo content, and a repository must not be able
	 * to raise how many unattended runs a machine starts or silence their
	 * notifications.
	 */
	readonly schedule?: ScheduleConfig
	/**
	 * Which `SKILL.md` skills a session offers. Absent means every tier,
	 * built-ins included, with nothing disabled.
	 */
	readonly skills?: SkillsConfig
	/**
	 * Composer triggers: words typed into the interactive composer that name
	 * one namzu action for that message — the `hypermode` keyword, a
	 * save-as-skill phrase — highlighted with a tag row before Enter and
	 * dropped with Alt+W. Absent means on, with each built-in at its default.
	 *
	 * Never read from the environment, and a project file (or a profile it
	 * declares) can only turn things down: it cannot switch the feature back
	 * on, raise a trigger from `suggest` to `arm`, or add a language the user
	 * file left out. `/config triggers off` writes `enabled: false` to the user
	 * file. Only the interactive terminal reads it; `exec`, `drain`, ACP and
	 * scheduled runs never act on composer triggers.
	 */
	readonly composerTriggers?: ComposerTriggersConfig
	/**
	 * A command whose first output lines replace the footer's resting hints:
	 * the terminal pipes one JSON object on its stdin (model, workspace,
	 * context window, cost, effort, pull request, ...) and shows what it
	 * prints, dimmed, above the footer row. File-only, never from the
	 * environment, like `hooks`: it runs a command with the operator's
	 * authority. A project file may set it only once the folder is trusted.
	 * Only the interactive terminal runs it. See `docs/cli/status-line.md`.
	 */
	readonly statusLine?: StatusLineConfig
}

/** See `NamzuCliConfig.statusLine`. */
export interface StatusLineConfig {
	/** The only kind there is; accepted so a block written for another terminal's settings pastes unchanged. */
	readonly type?: 'command'
	/** Run by the host shell in the working directory. */
	readonly command: string
	/** Columns of space on each side of the line. Default 0. */
	readonly padding?: number
	/** Also re-run every N seconds (at least 1), besides the event-driven updates. */
	readonly refreshInterval?: number
}

/** A composer trigger's arming: `arm` from typed text, `suggest` only (Alt+W arms), or `off`. */
export type ComposerTriggerArming = 'arm' | 'suggest' | 'off'

/** The built-in composer triggers. */
export type ComposerTriggerId = 'hypermode' | 'workflow' | 'save-skill' | 'schedule' | 'max-effort'

/** Languages whose phrases are matched. */
export type ComposerTriggerLanguage = 'en' | 'tr'

/** See `NamzuCliConfig.composerTriggers`. */
export interface ComposerTriggersConfig {
	/** The feature's one switch. Default `true`; `false` matches nothing at all. */
	readonly enabled?: boolean
	/** Offer loose matches and text that was not typed here as suggestions. Default `true`. */
	readonly suggest?: boolean
	/** Languages whose phrases are matched. Default `[en, tr]`. */
	readonly languages?: readonly ComposerTriggerLanguage[]
	/**
	 * Per built-in trigger. Defaults: `hypermode: arm`, `workflow: arm`, `save-skill: arm`,
	 * `schedule: suggest`, `max-effort: off`.
	 */
	readonly builtin?: Readonly<Partial<Record<ComposerTriggerId, ComposerTriggerArming>>>
}

/** See `NamzuCliConfig.skills`. */
export interface SkillsConfig {
	/**
	 * Offer the skills shipped with the CLI (the lowest-precedence tier).
	 * Default `true`; `false` leaves them out of listings and the model's
	 * manifest alike.
	 */
	readonly builtin?: boolean
	/**
	 * Skill names neither the model nor `/skills <name>` may use, whatever
	 * tier they come from. They stay in listings, marked disabled.
	 */
	readonly disabled?: readonly string[]
	/**
	 * After a turn that took several steps, the interactive terminal prints
	 * one dim line proposing to save it as a skill (`/skills save`). Nothing
	 * is saved without the operator. Default `true`; `false` stops the
	 * proposals (`/skills save off` writes it to the user config).
	 */
	readonly suggest?: boolean
	/**
	 * Successful tool calls a turn needs before it is proposed as a skill.
	 * Default 6.
	 */
	readonly suggestMinToolCalls?: number
}

/** See `NamzuCliConfig.schedule`. */
export interface ScheduleConfig {
	/** Runs of different jobs in progress at once. Default 2. */
	readonly maxConcurrentRuns?: number
	/** Desktop notifications for scheduled runs. Default true. */
	readonly notifications?: boolean
}

/**
 * See `NamzuCliConfig.decision`. Auth is declarative: the config names the
 * environment variable that holds a credential, never the credential itself.
 */
export type DecisionConfig =
	| {
			readonly provider: 'azure'
			/** Resource endpoint of the Azure AI Foundry deployment. */
			readonly endpoint: string
			/** Foundry deployment name. */
			readonly deployment: string
			/** Environment variable holding the Entra bearer token. Default `AZURE_FOUNDRY_TOKEN`. */
			readonly tokenEnv?: string
	  }
	| {
			readonly provider: 'http'
			/** Endpoint of an HTTP decision service. */
			readonly url: string
			/** Model name sent to the service, when it takes one. */
			readonly model?: string
			/** Environment variable holding a bearer token. Keyless when unset. */
			readonly apiKeyEnv?: string
	  }

/** A concrete model to run on: the provider that serves it and its exact id. */
export interface RoutingTarget {
	/** Provider id, matching one of your configured providers. */
	readonly provider: string
	/** Exact model id at that provider. */
	readonly model: string
}

/** See `NamzuCliConfig.routing`. */
export interface RoutingConfig {
	/** The model `auto` falls back to whenever it cannot or should not decide. Required. */
	readonly default: RoutingTarget
	readonly tiers?: {
		/** Small, quick model for short chat and one-step tasks. */
		readonly fast?: RoutingTarget
		/** Larger model for deep multi-step reasoning and wide code changes. */
		readonly big?: RoutingTarget
	}
	/**
	 * How tasks are sized. `yesno` (default) asks two calibrated yes/no
	 * questions; `score` asks for one four-level rating.
	 */
	readonly strategy?: 'yesno' | 'score'
	/** Minimum probability (0 to 1) to leave the default tier. Default 0.7 each. */
	readonly thresholds?: {
		readonly fast?: number
		readonly big?: number
	}
	/** Milliseconds the sizing call may take before the default runs. Default 1500. */
	readonly timeoutMs?: number
}

export interface TelemetryConfig {
	/**
	 * Write this session's run events somewhere.
	 *
	 * The disclosure `@namzu/telemetry`'s `describeSessionExport` builds
	 * from this is printed at boot, because the operator configuring it and
	 * the person whose conversation leaves the machine are frequently not
	 * the same person.
	 */
	readonly sessionExport?: SessionExportConfig
}

export interface SessionExportConfig {
	/**
	 * Absolute or cwd-relative path to a JSONL file, one record per line.
	 *
	 * A file, not a URL, and that is a limit rather than an oversight: a
	 * network destination needs retry, backpressure and a credential, and
	 * a CLI that shipped a half-built one would be offering an export that
	 * silently drops. A host that needs a collector builds a
	 * `SessionExportSink` and attaches the listener itself — that seam is
	 * the package's public surface.
	 */
	readonly destination: string
	/**
	 * Which run event types to export. Absent means all of them.
	 *
	 * Not validated against the event union here: a name that matches no
	 * event exports nothing under it, and the boot disclosure prints the
	 * list verbatim, so a typo is visible rather than silently widening.
	 */
	readonly eventTypes?: readonly string[]
	/**
	 * Redactors to install, in order. `secrets` is the shipped one.
	 *
	 * An empty array means NO redaction, and it is spelled that way on
	 * purpose: omitting the key installs the default, so a config has to
	 * say `[]` to turn redaction off rather than reach it by forgetting.
	 */
	readonly redactors?: readonly SessionExportRedactorName[]
}

/** The redactors this CLI can install by name. */
export type SessionExportRedactorName = 'secrets'

export interface SandboxConfig {
	/**
	 * Run commands inside an OS sandbox.
	 *
	 * Off by default: commands and file tools run on this machine, under the
	 * permission prompts, the way other coding agents run them — a shell
	 * command is reviewed before it runs, and a file tool's path outside the
	 * working directory and the added directories is an approval request,
	 * not a refusal. `true` confines each command to the working directory
	 * and the added directories, with the network cut where the platform can
	 * cut it; whatever the sandbox cannot reach then needs `/add-dir` or a
	 * per-command escape the user approves.
	 *
	 * Unset, it is on when `requireIsolation` names a control or `workspace`
	 * is `ephemeral`: both only mean anything inside a sandbox, and dropping
	 * a requirement because a switch was left at its default is the silent
	 * downgrade this key exists to prevent. The resolved state is announced
	 * on startup either way.
	 */
	readonly enabled?: boolean
	/**
	 * Whether a sandboxed `bash` call may ask to run one command outside the
	 * sandbox (`dangerously_disable_sandbox`). Default `true`: the request is
	 * put to the user every time — `auto` and `--yolo` included; `plan` and
	 * `strict` refuse it — and written to the session's audit trail. `false`
	 * refuses every such request.
	 */
	readonly allowEscape?: boolean
	/**
	 * Whether that escape may be granted with nobody to ask (a headless or
	 * `--print` turn, a drained turn). Default `false`: an unattended escape
	 * is refused. `true` grants it without a prompt, on the audit record;
	 * set it only for a host where leaving the sandbox is already decided.
	 */
	readonly allowUnattendedEscape?: boolean
	/**
	 * Controls this machine must actually enforce, or the CLI refuses to
	 * start.
	 *
	 * Empty by default, and the default is honest rather than safe: the
	 * available isolation differs per platform, so requiring anything by
	 * default would refuse to run on machines where the CLI works today.
	 * What the sandbox does and does not confine is reported on startup
	 * either way — an operator who needs a guarantee names it here and gets
	 * a refusal instead of a surprise.
	 */
	readonly requireIsolation?: readonly ('filesystem' | 'network' | 'process')[]
	/**
	 * Filesystem tree exposed as the sandbox root.
	 *
	 * The coding CLI defaults to `working-directory`: every turn gets a fresh
	 * process boundary over the same caller-owned project. `ephemeral` opts into
	 * a disposable empty tree for one-shot work.
	 */
	readonly workspace?: 'working-directory' | 'ephemeral'
	/**
	 * How long a completed or cancelled turn waits for sandbox teardown.
	 * Defaults to 30 seconds. Set to `0` to preserve the former unbounded wait.
	 */
	readonly teardownTimeoutMs?: number
}

export const DEFAULT_CONFIG: NamzuCliConfig = Object.freeze({
	format: 'text',
	quiet: false,
})
