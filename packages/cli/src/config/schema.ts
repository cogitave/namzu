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
import type { PermissionChecksConfig } from '../permissions/checks.js'
import type { PermissionsConfig } from '../permissions/rules.js'
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
export type TerminalNotificationEvent = 'turn-settled' | 'approval-required'

/** Escape protocol used for an opted-in terminal notification. */
export type TerminalNotificationMethod = 'osc9' | 'bel'

export interface TuiConfig {
	/**
	 * Notify for TUI events through the terminal itself.
	 *
	 * Absent or `false` means off. `true` enables both events; a list enables
	 * only the named events, and an empty list explicitly disables all of them.
	 * No command is started and no conversation content is included.
	 */
	readonly notifications?: boolean | readonly TerminalNotificationEvent[]
	/** Terminal protocol to write. Defaults to `osc9` when notifications are on. */
	readonly notificationMethod?: TerminalNotificationMethod
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
}

/** See `NamzuCliConfig.web`. */
export interface WebConfig {
	/** Web search is live by default. Set off to disable it. */
	readonly search?: 'off' | 'cached' | 'live'
	/** Auto prefers declared native support, otherwise Exa. Explicit choices never silently switch. */
	readonly backend?: 'auto' | 'exa' | 'native'
	/** Mount `web_fetch` over the guarded provider. Default `false`. */
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
}

/** See `NamzuCliConfig.schedule`. */
export interface ScheduleConfig {
	/** Runs of different jobs in progress at once. Default 2. */
	readonly maxConcurrentRuns?: number
	/** Desktop notifications for scheduled runs. Default true. */
	readonly notifications?: boolean
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
