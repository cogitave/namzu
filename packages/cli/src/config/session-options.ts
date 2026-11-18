import { resolve } from 'node:path'

import { type LaunchEnvironment, launchRefusal } from '../permissions/launch.js'
import type { AgentSessionOptions } from '../tui/agent.js'
import { hookSwitch } from './hook-layers.js'
import type { NamzuCliConfig, TurnLimitsConfig } from './schema.js'

/**
 * The one place a loaded configuration becomes the options of a session.
 *
 * `namzu exec`, `exec --json` and the ACP host (what Desktop runs) each used
 * to spell this out by hand, and each missed keys another passed: Desktop
 * saved a spending limit it never read. They all call this now, so a key
 * added here reaches every host, and `session-options.test.ts` fails when a
 * key is added to the schema without being named here or excluded below with
 * a reason.
 */

/** What a host adds to the configuration: command-line flags and its own resolution. */
export interface SessionOptionsExtras {
	/** The folder the session works in; relative `additionalDirectories` resolve against it. */
	readonly cwd: string
	/** Flag overrides of the `limits` block, each winning over the file. */
	readonly limitsFromFlags?: TurnLimitsConfig
	/** `--hand-back`: on even when the config leaves it off. */
	readonly handBackFlag?: boolean
	/** Tool servers after the host resolved its flags; absent: the config's own. */
	readonly mcpServers?: AgentSessionOptions['mcpServers']
}

/** The session options a configuration decides. Hosts spread this and add their own. */
export type ConfigSessionOptions = Pick<
	AgentSessionOptions,
	| 'learningObservations'
	| 'permissionSettings'
	| 'mcpServers'
	| 'plugins'
	| 'skills'
	| 'web'
	| 'smallModel'
	| 'hooks'
	| 'hooksSwitch'
	| 'compaction'
	| 'memory'
	| 'limits'
	| 'workflow'
	| 'handBack'
	| 'savedEffort'
	| 'closingSummary'
	| 'outputStyle'
	| 'attribution'
	| 'sandbox'
	| 'decision'
	| 'toolResultScreens'
	| 'codeAnalysis'
	| 'additionalDirectories'
>

/**
 * Every top-level configuration key, and where it goes. A key is either
 * mapped by `sessionOptionsFromConfig` (the session option it feeds) or
 * excluded with the reason no session option is built from it. The guard test
 * compares this table with the schema.
 */
export const SESSION_KEY_MAP: Readonly<Record<keyof NamzuCliConfig, string>> = {
	format: 'excluded: how the command prints, not the session',
	quiet: 'excluded: how the command prints, not the session',
	permissions: 'excluded: compiled to rules by the host with its own flag layers (`rules`)',
	permissionLayers: 'excluded: compiled to rules by the host with its own flag layers (`rules`)',
	permissionSettings: 'permissionSettings',
	permissionChecks: 'excluded: read by the permission compiler the host calls, not by the session',
	profiles: 'excluded: resolved into the loaded config before any host reads it',
	mcpServers: 'mcpServers',
	plugins: 'plugins',
	limits: 'limits',
	workflow: 'workflow',
	goal: 'excluded: goal rounds are driven by the terminal app, not by a session option',
	handBack: 'handBack',
	worktrees: 'excluded: read when a worktree is made (`openManagedWorktrees`), not by the session',
	statusMarks: 'excluded: a sidebar display choice read by the desktop app, not by the session',
	effort: 'savedEffort',
	fast: 'excluded: read once by the terminal app at launch, like `--fast`; no other host has fast mode',
	respectGitignore:
		'excluded: read by the terminal app and the desktop app for their file pickers, not by the session',
	closingSummary: 'closingSummary',
	outputStyle: 'outputStyle',
	attribution: 'attribution',
	promptSuggestions:
		'excluded: read by the terminal app after a reply, not by the session; no other host draws a suggestion',
	archiveInactive:
		'excluded: read by the desktop host when it lists conversations, not by the session',
	sandbox: 'sandbox',
	web: 'web',
	browser: 'excluded: the browser needs a host to own it (Desktop builds it in the ACP host)',
	codeAnalysis: 'codeAnalysis',
	decision: 'decision',
	model: 'excluded: picks the model, which the host decides with `routing` and its provider flags',
	routing: 'excluded: only a host that routes (Auto) passes it, and each decides when',
	smallModel: 'smallModel',
	hooks: 'hooks',
	disableHooks: 'hooksSwitch',
	hooksManagedOnly: 'hooksSwitch',
	additionalDirectories: 'additionalDirectories',
	toolResultScreens: 'toolResultScreens',
	compaction: 'compaction',
	memory: 'memory',
	telemetry: 'excluded: set up once by the process, not per session',
	tui: 'excluded: terminal display settings',
	updates: 'excluded: the self-updater, not a session',
	modelCatalogueRefresh: 'excluded: read by the catalogue refresher at start, not by a session',
	hypermode: 'excluded: a per-turn send option, see `turnOptionsFromConfig`',
	refusalFallback: 'excluded: a per-turn send option, see `turnOptionsFromConfig`',
	progressNudge:
		'excluded: needs to know whether anyone watches, so each host resolves it with `resolveProgressNudge`',
	learningObservations: 'learningObservations',
	learningGenerator: 'excluded: the terminal app starts the generator, no session option reads it',
	schedule: 'excluded: read by the scheduler daemon',
	skills: 'skills',
	composerTriggers: 'excluded: terminal composer keywords',
	statusLine: 'excluded: terminal status line',
}

export function sessionOptionsFromConfig(
	config: NamzuCliConfig,
	extras: SessionOptionsExtras,
): ConfigSessionOptions {
	const limits = { ...config.limits, ...extras.limitsFromFlags }
	const mcpServers = extras.mcpServers ?? config.mcpServers
	const hooksSwitch = hookSwitch(config)
	const additionalDirectories = (config.additionalDirectories ?? []).map((dir) =>
		resolve(extras.cwd, dir),
	)
	return {
		learningObservations: config.learningObservations !== false,
		...(config.permissionSettings ? { permissionSettings: config.permissionSettings } : {}),
		...(mcpServers ? { mcpServers } : {}),
		...(config.plugins ? { plugins: config.plugins } : {}),
		...(config.skills ? { skills: config.skills } : {}),
		...(config.web ? { web: config.web } : {}),
		...(config.smallModel ? { smallModel: config.smallModel } : {}),
		...(config.hooks ? { hooks: config.hooks } : {}),
		...(hooksSwitch ? { hooksSwitch } : {}),
		...(config.compaction ? { compaction: config.compaction } : {}),
		...(config.memory ? { memory: config.memory } : {}),
		...(Object.keys(limits).length > 0 ? { limits } : {}),
		...(config.workflow ? { workflow: config.workflow } : {}),
		...(extras.handBackFlag || config.handBack?.enabled === true ? { handBack: true } : {}),
		...(config.effort ? { savedEffort: config.effort } : {}),
		...(config.closingSummary === false ? { closingSummary: false } : {}),
		...(config.outputStyle ? { outputStyle: config.outputStyle } : {}),
		...(config.attribution ? { attribution: config.attribution } : {}),
		...(config.sandbox ? { sandbox: config.sandbox } : {}),
		...(config.decision ? { decision: config.decision } : {}),
		...(config.codeAnalysis ? { codeAnalysis: config.codeAnalysis } : {}),
		...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
		// `!== undefined`, not truthiness: an empty list is the operator turning
		// the default screen OFF, and a falsy check would drop it.
		...(config.toolResultScreens !== undefined
			? { toolResultScreens: config.toolResultScreens }
			: {}),
	}
}

/** What a configuration decides about each turn, rather than the session. */
export function turnOptionsFromConfig(config: NamzuCliConfig): {
	readonly hypermode?: true
	readonly refusalFallback?: NonNullable<NamzuCliConfig['refusalFallback']>
} {
	return {
		// The standing hypermode: on for every turn, as the terminal starts it.
		...(config.hypermode === true ? { hypermode: true as const } : {}),
		...(config.refusalFallback ? { refusalFallback: config.refusalFallback } : {}),
	}
}

/**
 * The prompt permission modes a host advertises: Auto (`classify`) and bypass,
 * each left out when the configuration or the machine closes it (the same
 * decision `launchRefusal` makes when the pick arrives, so the list and the
 * refusal cannot disagree). An empty list means neither is on offer.
 */
export function advertisedPromptModes(
	config: NamzuCliConfig,
	environment?: LaunchEnvironment,
): ('bypass' | 'classify')[] {
	const settings = config.permissionSettings
	return (['bypass', 'classify'] as const).filter(
		(mode) => launchRefusal(mode, { settings, environment }) === undefined,
	)
}
