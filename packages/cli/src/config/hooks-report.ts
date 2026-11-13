/**
 * One answer to "what runs by itself in this folder", for a program to read.
 *
 * `/hooks`, `namzu doctor`, the folder trust prompt, `namzu hooks` and the
 * Desktop app all need the same facts: every hook that runs, or could come to
 * run, in a folder, where it comes from, whether it is on, and why not when it
 * is not. This module reads them once, through the readers a session uses
 * (the config reader, the plugin entry reader, the skill and agent hook
 * readers), and returns data, not text.
 *
 * Nothing of the folder is executed or imported to produce the answer. A
 * plugin's manifest and its files of entries are read as text and its
 * JavaScript modules are only named; a skill's and an agent file's `hooks`
 * are read as text. For a folder nobody has trusted, what the folder's own
 * files would start is listed with the state `not-loaded` and the reason
 * `folder-not-trusted`; none of it is counted as running.
 *
 * The shape is a contract (`HOOKS_REPORT_VERSION`): fields are added, never
 * removed or renamed, and a reader ignores the ones it does not know.
 */

import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import {
	SHELL_HOOK_PASCAL_EVENT_NAMES,
	type ShellHookEvent,
	fileChangedMatcherNote,
	shellHookIfProblem,
	shellHookMatcherProblem,
} from '@namzu/sdk'

import { readPluginHookSources } from '../integrations/plugins/hook-entries.js'
import { PluginSettingsStore } from '../integrations/plugins/settings.js'
import { resolveNamzuHome } from '../integrations/state/home.js'
import { readAgentHooks } from '../integrations/subagents/agent-hooks.js'
import { discoverAgentDefinitions } from '../integrations/subagents/definitions.js'
import { isTrusted } from '../integrations/trust/store.js'
import { discoverSkills } from '../skills/store.js'
import { type HooksSwitch, assembleHooks, hookIdentity, hookSwitch } from './hook-layers.js'
import {
	type ConfigProvenance,
	type ConfigSource,
	type DeclaredHookLayer,
	type DeclaredHooks,
	LOCAL_CONFIG_FILE,
	loadBootstrapConfigWithProvenance,
	loadConfigWithProvenance,
	shortHomePath,
	withHookLayerSink,
	withHookProblemSink,
} from './load.js'
import type { HookEntry, HooksConfig, NamzuCliConfig } from './schema.js'
import { readSkillHooks, withoutSessionStart } from './skill-hooks-reader.js'

/** The shape's version. Additive changes keep it; a change a reader could not ignore moves it. */
export const HOOKS_REPORT_VERSION = 1

/** Where a hook comes from. */
export type HookOriginKind = 'config' | 'plugin' | 'skill' | 'agent'

export interface HookOrigin {
	readonly kind: HookOriginKind
	/** What a person is shown: a file's path, `plugin <name>`, `skill <name>`, `agent <name>`. */
	readonly label: string
	/** The plugin, skill or agent's name. */
	readonly name?: string
	/** The file or folder it was read from, as a person reads a path (home as `~`). */
	readonly path?: string
	/**
	 * Which layer: `user`, `project`, `local`, `profile`, `managed` for a config file;
	 * `user`, `project` for a plugin or an agent file; `system`, `user`, `project` for a skill.
	 */
	readonly scope?: string
}

/**
 * `runs`: it fires on its event now. `off`: a switch or a setting leaves it out (`why.code` says which).
 * `attaches-when-used`: a skill or an agent file's hook, attached while it is in use. `not-loaded`: it
 * cannot run now (`why.code` says why, for example `folder-not-trusted`).
 */
export type HookState = 'runs' | 'off' | 'attaches-when-used' | 'not-loaded'

/** The reason codes. A reader treats a code it does not know as an unexplained `off` or `not-loaded`. */
export type HookWhyCode =
	| 'disableHooks'
	| 'hooksManagedOnly'
	| 'plugins-disabled'
	| 'plugin-disabled'
	| 'skill-disabled'
	| 'folder-not-trusted'
	| 'skill-unusable'
	| 'agent-not-offered'

export interface HookWhy {
	readonly code: HookWhyCode
	/** One sentence for a person. */
	readonly text: string
}

export type HookType = 'command' | 'http' | 'prompt'

export interface HookRow {
	/** Stable for the same entry from the same source, so a view can keep its place. */
	readonly id: string
	/** The event, as this kernel names it (`pre_tool_use`). */
	readonly event: string
	/** The other spelling, where the event has one (`PreToolUse`). */
	readonly eventWritten?: string
	readonly matcher?: string
	/** The entry's `if` filter. */
	readonly condition?: string
	readonly type: HookType
	/**
	 * What it starts: the command with its arguments, `POST <address>` (no query, no credentials), or the
	 * first line of a prompt. Never an environment value or a header.
	 */
	readonly runs: string
	readonly origin: HookOrigin
	readonly state: HookState
	readonly why?: HookWhy
	readonly once?: boolean
	/** A command that is started and not waited for. */
	readonly async?: boolean
	readonly timeoutMs?: number
	/** `block` when the hook's own failure refuses what it guards. */
	readonly onFailure?: string
	/** What the reader said about this one entry (a matcher or `if` that cannot be read, a file_changed matcher that names no file). */
	readonly notes?: readonly string[]
}

/** A JavaScript module a plugin lists as hooks. It is named, never imported. */
export interface HookModuleRow {
	readonly plugin: string
	readonly module: string
	readonly origin: HookOrigin
	readonly state: HookState
	readonly why?: HookWhy
}

export interface HookProblem {
	/** `problem`: a hook that would have guarded something was lost. `note`: anything else. */
	readonly severity: 'problem' | 'note'
	readonly origin: HookOrigin
	/** The event as the source spells it, when the problem is about one. */
	readonly event?: string
	/** The file inside a plugin the problem is about. */
	readonly file?: string
	readonly message: string
	/** Set when the source is not read as running (the folder is not trusted). */
	readonly inactive?: 'folder-not-trusted'
}

/** Where a setting was set, in the words of the cascade. */
export interface SwitchSource {
	readonly kind:
		| 'default'
		| 'user-file'
		| 'project-file'
		| 'local-file'
		| 'profile'
		| 'env'
		| 'managed'
	readonly path?: string
	readonly variable?: string
	readonly profile?: string
}

export interface SwitchReport {
	readonly on: boolean
	/** Where it was set; absent when nothing set it. */
	readonly setBy?: SwitchSource
}

export interface HooksSwitches {
	/** `disableHooks` or NAMZU_DISABLE_HOOKS: turns off hooks that are not from the managed file. */
	readonly disableHooks: SwitchReport
	/** `hooksManagedOnly`, honoured only from the managed file. */
	readonly hooksManagedOnly: SwitchReport
	/** `plugins.enabled`: plugins, and with them the hook entries they ship, are off unless it is on. */
	readonly plugins: SwitchReport
	/** The one limiting hooks now, `managed-only` outranking `disabled`; absent when none is. */
	readonly limiting?: HooksSwitch
}

export interface HooksReport {
	readonly version: typeof HOOKS_REPORT_VERSION
	readonly folder: {
		readonly path: string
		/** The folder is trusted. When it is not, the folder's own files, plugins, skills and agent files are listed as `not-loaded`. */
		readonly trusted: boolean
	}
	readonly switches: HooksSwitches
	readonly hooks: readonly HookRow[]
	readonly modules: readonly HookModuleRow[]
	readonly problems: readonly HookProblem[]
	readonly counts: {
		readonly runs: number
		readonly off: number
		readonly attachesWhenUsed: number
		readonly notLoaded: number
		/** The part of `notLoaded` that starts once the folder is trusted. */
		readonly waitingForTrust: number
		readonly problems: number
	}
	/** Set when the configuration could not be read; what could still be read is listed. */
	readonly error?: string
}

export interface DescribeFolderHooksOptions {
	readonly cwd: string
	/** Override the user's home (tests). */
	readonly home?: string
	readonly env?: NodeJS.ProcessEnv
	readonly profile?: string
	readonly managedPath?: string
	/** Whether the folder is trusted; absent, the trust store says. */
	readonly trusted?: boolean
}

const MAX_RUNS_CHARS = 200

const clip = (text: string, max = MAX_RUNS_CHARS): string => {
	const flat = text.replace(/\s+/g, ' ').trim()
	return flat.length > max ? `${flat.slice(0, max)}...` : flat
}

/** The address without credentials or a query, which can carry a token. */
function plainAddress(url: string): string {
	try {
		const parsed = new URL(url)
		return `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
	} catch {
		return url.split(/[?#]/)[0] ?? url
	}
}

/** What an entry starts, in a line. */
export function describeHookRuns(entry: HookEntry): string {
	if (entry.type === 'http') return `POST ${plainAddress(entry.url)}`
	if (entry.type === 'prompt') {
		const first = entry.prompt.split(/\r?\n/).find((line) => line.trim().length > 0) ?? ''
		return clip(first)
	}
	return clip([entry.command, ...(entry.args ?? [])].join(' '))
}

function switchSource(source: ConfigSource | undefined): SwitchSource | undefined {
	if (source === undefined) return undefined
	switch (source.kind) {
		case 'default':
			return { kind: 'default' }
		case 'env':
			return { kind: 'env', variable: source.variable }
		case 'profile':
			return { kind: 'profile', path: shortHomePath(source.path), profile: source.name }
		default:
			return { kind: source.kind, path: shortHomePath(source.path) }
	}
}

function switchReport(on: boolean, source: ConfigSource | undefined): SwitchReport {
	const setBy = switchSource(source)
	return { on, ...(setBy !== undefined ? { setBy } : {}) }
}

/** One resolution of the config, with what the hook readers said and the hook layers it saw. */
interface Resolved {
	config: NamzuCliConfig
	provenance: ConfigProvenance
	layers: readonly DeclaredHookLayer[]
	switches: DeclaredHooks['switches']
	problems: { event: string; severity: 'problem' | 'note'; message: string; file: string }[]
	error?: string
}

function resolveConfig(
	load: () => { config: NamzuCliConfig; provenance: ConfigProvenance },
): Resolved {
	const problems: Resolved['problems'] = []
	let declared: DeclaredHooks | undefined
	try {
		const { config, provenance } = withHookProblemSink(
			(event, severity, message, file) => problems.push({ event, severity, message, file }),
			() =>
				withHookLayerSink((seen) => {
					declared = seen
				}, load),
		)
		return {
			config,
			provenance,
			layers: declared?.layers ?? [],
			switches: declared?.switches ?? { disableHooks: false, managedOnly: false },
			problems,
		}
	} catch (error) {
		return {
			config: {} as NamzuCliConfig,
			provenance: {},
			layers: declared?.layers ?? [],
			switches: declared?.switches ?? { disableHooks: false, managedOnly: false },
			problems,
			error: error instanceof Error ? error.message.split('\n')[0]?.slice(0, 300) : 'unreadable',
		}
	}
}

function configScope(source: ConfigSource): string {
	switch (source.kind) {
		case 'user-file':
			return 'user'
		case 'project-file':
			return 'project'
		case 'local-file':
			return 'local'
		case 'profile':
			return 'profile'
		case 'managed':
			return 'managed'
		default:
			return source.kind
	}
}

/** A layer the folder itself supplies: its two files, or a profile declared in them. */
function isFolderLayer(source: ConfigSource): boolean {
	return (
		source.kind === 'project-file' ||
		source.kind === 'local-file' ||
		(source.kind === 'profile' && source.repository === true)
	)
}

function rowId(origin: HookOrigin, event: string, entry: HookEntry): string {
	return createHash('sha256')
		.update(JSON.stringify([origin.kind, origin.label, hookIdentity(event, entry)]))
		.digest('hex')
		.slice(0, 12)
}

function readingNotes(event: string, entry: HookEntry): string[] {
	const notes = [shellHookMatcherProblem(entry.matcher), shellHookIfProblem(entry.if)].filter(
		(problem): problem is string => problem !== undefined,
	)
	if (event === 'file_changed') {
		const note = fileChangedMatcherNote(entry.matcher)
		if (note !== undefined) notes.push(note)
	}
	return notes
}

function makeRow(
	origin: HookOrigin,
	event: string,
	entry: HookEntry,
	state: HookState,
	why: HookWhy | undefined,
): HookRow {
	const notes = readingNotes(event, entry)
	const written = SHELL_HOOK_PASCAL_EVENT_NAMES[event as ShellHookEvent]
	return {
		id: rowId(origin, event, entry),
		event,
		...(written !== undefined && written !== event ? { eventWritten: written } : {}),
		...(entry.matcher !== undefined && entry.matcher !== '' ? { matcher: entry.matcher } : {}),
		...(entry.if !== undefined && entry.if !== '' ? { condition: entry.if } : {}),
		type: entry.type ?? 'command',
		runs: describeHookRuns(entry),
		origin,
		state,
		...(why !== undefined ? { why } : {}),
		...(entry.once === true ? { once: true } : {}),
		...((entry.type === undefined || entry.type === 'command') && entry.async === true
			? { async: true }
			: {}),
		...(entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {}),
		...(entry.onFailure !== undefined ? { onFailure: entry.onFailure } : {}),
		...(notes.length > 0 ? { notes } : {}),
	}
}

const OFF_TEXT: Record<'disableHooks' | 'hooksManagedOnly', string> = {
	disableHooks:
		'disableHooks (or NAMZU_DISABLE_HOOKS) is on: hooks that are not from the managed file are off.',
	hooksManagedOnly:
		'hooksManagedOnly is on: only the managed file’s hooks run, and no hook from your files, the folder, a plugin, a skill or an agent file does.',
}

const UNTRUSTED: HookWhy = {
	code: 'folder-not-trusted',
	text: 'This folder is not trusted. It starts once the folder is trusted.',
}

function switchWhy(state: HooksSwitch): HookWhy {
	const code = state === 'managed-only' ? 'hooksManagedOnly' : 'disableHooks'
	return { code, text: OFF_TEXT[code] }
}

/** Every hook that runs, or could come to run, in this folder. See the module comment. */
export async function describeFolderHooks(
	options: DescribeFolderHooksOptions,
): Promise<HooksReport> {
	const cwd = resolve(options.cwd)
	const trusted = options.trusted ?? isTrusted(cwd, options.home)
	const loadOptions = {
		cwd,
		...(options.home !== undefined ? { home: options.home } : {}),
		...(options.env !== undefined ? { env: options.env } : {}),
		...(options.profile !== undefined ? { profile: options.profile } : {}),
		...(options.managedPath !== undefined ? { managedPath: options.managedPath } : {}),
	}
	// What the folder's own files declare is read in every case, as text; what is applied
	// now is the bootstrap resolution (no folder file) while the folder is not trusted.
	const full = resolveConfig(() => loadConfigWithProvenance(loadOptions))
	const applied = trusted
		? full
		: resolveConfig(() => loadBootstrapConfigWithProvenance(loadOptions))
	const effective = applied.error === undefined ? applied : full
	const provenance = effective.provenance
	const state = hookSwitch(effective.config)

	const hooks: HookRow[] = []
	const problems: HookProblem[] = []
	const modules: HookModuleRow[] = []

	// ---- config files ------------------------------------------------------
	const layerByLabel = new Map<string, DeclaredHookLayer>()
	for (const layer of full.layers) layerByLabel.set(layer.label, layer)
	const folderLayers = full.layers.filter((layer) => isFolderLayer(layer.source))
	const appliedLayers = trusted
		? full.layers
		: full.layers.filter((layer) => !isFolderLayer(layer.source))
	const attachedNow = assembleHooks(appliedLayers, applied.switches).hooks
	const attachedIdentities = new Set<string>()
	const attachedLabel = new Map<string, string>()
	for (const [event, entries] of Object.entries(attachedNow ?? {})) {
		for (const entry of entries ?? []) {
			const identity = hookIdentity(event, entry)
			attachedIdentities.add(identity)
			attachedLabel.set(identity, entry.source ?? '')
		}
	}
	const everything = assembleHooks(full.layers, { disableHooks: false, managedOnly: false }).hooks
	for (const [event, entries] of Object.entries(everything ?? {})) {
		for (const entry of (entries ?? []) as readonly HookEntry[]) {
			const identity = hookIdentity(event, entry)
			const running = attachedIdentities.has(identity)
			const label = running ? (attachedLabel.get(identity) ?? '') : (entry.source ?? '')
			const layer = layerByLabel.get(label)
			const source = layer?.source
			const origin: HookOrigin = {
				kind: 'config',
				label,
				...(source !== undefined && 'path' in source ? { path: shortHomePath(source.path) } : {}),
				...(source !== undefined ? { scope: configScope(source) } : {}),
				...(source?.kind === 'profile' ? { name: source.name } : {}),
			}
			let rowState: HookState = 'runs'
			let why: HookWhy | undefined
			if (!running) {
				if (!trusted && source !== undefined && isFolderLayer(source)) {
					rowState = 'not-loaded'
					why = UNTRUSTED
				} else {
					rowState = 'off'
					why = switchWhy(state ?? 'disabled')
				}
			}
			hooks.push(makeRow(origin, event, entry, rowState, why))
		}
	}
	const folderLabels = new Set(folderLayers.map((layer) => layer.label))
	const folderFiles = [resolve(cwd, 'namzu.config.json'), resolve(cwd, LOCAL_CONFIG_FILE)].map(
		shortHomePath,
	)
	for (const problem of full.problems) {
		const inFolder =
			folderLabels.has(problem.file) ||
			folderFiles.some((file) => problem.file === file || problem.file.startsWith(`${file} `))
		const layer = layerByLabel.get(problem.file)
		problems.push({
			severity: problem.severity,
			origin: {
				kind: 'config',
				label: problem.file,
				...(layer !== undefined && 'path' in layer.source
					? { path: shortHomePath(layer.source.path) }
					: {}),
				...(layer !== undefined ? { scope: configScope(layer.source) } : {}),
			},
			event: problem.event,
			message: problem.message,
			...(inFolder && !trusted ? { inactive: 'folder-not-trusted' as const } : {}),
		})
	}
	if (full.error !== undefined) {
		problems.push({
			severity: 'problem',
			origin: { kind: 'config', label: 'configuration' },
			message: `The configuration could not be read: ${full.error}`,
		})
	}

	// ---- plugins -----------------------------------------------------------
	const pluginsOn = effective.config.plugins?.enabled === true
	const home = resolveNamzuHome({
		...(options.home !== undefined ? { home: options.home } : {}),
		...(options.env !== undefined ? { env: options.env } : {}),
	})
	try {
		const settings = new PluginSettingsStore(home)
		const plugins = await readPluginHookSources({
			cwd,
			home,
			allowedScopes: effective.config.plugins?.allowedScopes ?? ['project', 'user'],
			autoDiscovery: effective.config.plugins?.autoDiscovery ?? true,
			trusted,
			includeUntrusted: true,
			enabled: (plugin) => settings.read(plugin),
		})
		for (const plugin of plugins) {
			const origin: HookOrigin = {
				kind: 'plugin',
				label: `plugin ${plugin.name}`,
				name: plugin.name,
				path: shortHomePath(plugin.rootDir),
				scope: plugin.scope,
			}
			const untrusted = plugin.scope === 'project' && !trusted
			const pluginState = (js: boolean): { state: HookState; why?: HookWhy } => {
				if (untrusted) return { state: 'not-loaded', why: UNTRUSTED }
				if (state !== undefined && !js) return { state: 'off', why: switchWhy(state) }
				if (!pluginsOn) {
					return {
						state: 'off',
						why: {
							code: 'plugins-disabled',
							text: 'plugins are off (plugins.enabled is not on), so what a plugin ships does not run.',
						},
					}
				}
				if (!plugin.enabled) {
					return {
						state: 'off',
						why: { code: 'plugin-disabled', text: `plugin ${plugin.name} is switched off.` },
					}
				}
				return { state: 'runs' }
			}
			const entries = pluginState(false)
			for (const [event, list] of Object.entries(plugin.entries as HooksConfig)) {
				for (const entry of list ?? []) {
					hooks.push(makeRow(origin, event, entry, entries.state, entries.why))
				}
			}
			const js = pluginState(true)
			for (const module of plugin.modules) {
				modules.push({
					plugin: plugin.name,
					module,
					origin,
					state: js.state,
					...(js.why !== undefined ? { why: js.why } : {}),
				})
			}
			for (const problem of plugin.problems) {
				problems.push({
					severity: problem.severity,
					origin,
					file: problem.file,
					message: problem.message,
					...(untrusted ? { inactive: 'folder-not-trusted' as const } : {}),
				})
			}
		}
	} catch (error) {
		problems.push({
			severity: 'note',
			origin: { kind: 'plugin', label: 'plugins' },
			message: `Plugins could not be read: ${error instanceof Error ? error.message.slice(0, 200) : 'unreadable'}`,
		})
	}

	// ---- skills ------------------------------------------------------------
	try {
		const skills = discoverSkills({
			cwd,
			...(options.home !== undefined ? { home: options.home } : {}),
			...(effective.config.skills ? { config: effective.config.skills } : {}),
		})
		for (const skill of skills) {
			if (skill.hooksSource === undefined) continue
			const origin: HookOrigin = {
				kind: 'skill',
				label: `skill ${skill.name}`,
				name: skill.name,
				path: shortHomePath(skill.path),
				scope: skill.source,
			}
			const untrusted = skill.source === 'project' && !trusted
			if (skill.problem !== undefined) {
				problems.push({
					severity: 'note',
					origin,
					message: `The skill cannot be used (${clip(skill.problem, 200)}), so the hooks it carries are not read.`,
					...(untrusted ? { inactive: 'folder-not-trusted' as const } : {}),
				})
				continue
			}
			const read = withoutSessionStart(readSkillHooks(skill.hooksSource, `skill ${skill.name}`))
			let rowState: HookState = 'attaches-when-used'
			let why: HookWhy | undefined
			if (untrusted) {
				rowState = 'not-loaded'
				why = UNTRUSTED
			} else if (state !== undefined) {
				rowState = 'off'
				why = switchWhy(state)
			} else if (skill.disabled === true) {
				rowState = 'off'
				why = {
					code: 'skill-disabled',
					text: `skill ${skill.name} is named in skills.disabled.`,
				}
			}
			for (const [event, list] of Object.entries(read.hooks as HooksConfig)) {
				for (const entry of list ?? []) hooks.push(makeRow(origin, event, entry, rowState, why))
			}
			for (const problem of read.problems) {
				problems.push({
					severity: problem.severity,
					origin,
					event: problem.event,
					message: problem.message,
					...(untrusted ? { inactive: 'folder-not-trusted' as const } : {}),
				})
			}
			if (read.guardLost) {
				problems.push({
					severity: 'problem',
					origin,
					message:
						read.count === 0
							? 'The skill loads without its hooks and without its allowed-tools pre-approval.'
							: 'The skill attaches the hooks that could be read and loads without its allowed-tools pre-approval.',
					...(untrusted ? { inactive: 'folder-not-trusted' as const } : {}),
				})
			}
		}
	} catch (error) {
		problems.push({
			severity: 'note',
			origin: { kind: 'skill', label: 'skills' },
			message: `Skills could not be read: ${error instanceof Error ? error.message.slice(0, 200) : 'unreadable'}`,
		})
	}

	// ---- agent files -------------------------------------------------------
	try {
		const found = await discoverAgentDefinitions({
			cwd,
			...(options.home !== undefined ? { home: options.home } : {}),
		})
		for (const agent of found.carriers) {
			const origin: HookOrigin = {
				kind: 'agent',
				label: `agent ${agent.name}`,
				name: agent.name,
				path: shortHomePath(agent.path),
				scope: agent.source,
			}
			const untrusted = agent.source === 'project' && !trusted
			const read = readAgentHooks(agent.hooksSource, agent.name)
			let rowState: HookState = 'attaches-when-used'
			let why: HookWhy | undefined
			if (untrusted) {
				rowState = 'not-loaded'
				why = UNTRUSTED
			} else if (state !== undefined) {
				rowState = 'off'
				why = switchWhy(state)
			} else if (read.guardLost) {
				rowState = 'not-loaded'
				why = {
					code: 'agent-not-offered',
					text: 'The agent is not offered until the hook entry that could not be loaded is fixed or taken out.',
				}
			}
			for (const [event, list] of Object.entries(read.hooks as HooksConfig)) {
				for (const entry of list ?? []) hooks.push(makeRow(origin, event, entry, rowState, why))
			}
			for (const problem of read.problems) {
				problems.push({
					severity: problem.severity,
					origin,
					event: problem.event,
					message: problem.message,
					...(untrusted ? { inactive: 'folder-not-trusted' as const } : {}),
				})
			}
		}
	} catch (error) {
		problems.push({
			severity: 'note',
			origin: { kind: 'agent', label: 'agent files' },
			message: `Agent files could not be read: ${error instanceof Error ? error.message.slice(0, 200) : 'unreadable'}`,
		})
	}

	const count = (wanted: HookState): number => hooks.filter((row) => row.state === wanted).length
	return {
		version: HOOKS_REPORT_VERSION,
		folder: { path: cwd, trusted },
		switches: {
			disableHooks: switchReport(effective.switches.disableHooks, provenance.disableHooks),
			hooksManagedOnly: switchReport(effective.switches.managedOnly, provenance.hooksManagedOnly),
			plugins: switchReport(pluginsOn, provenance.plugins),
			...(state !== undefined ? { limiting: state } : {}),
		},
		hooks,
		modules,
		problems,
		counts: {
			runs: count('runs'),
			off: count('off'),
			attachesWhenUsed: count('attaches-when-used'),
			notLoaded: count('not-loaded'),
			waitingForTrust: hooks.filter((row) => row.why?.code === 'folder-not-trusted').length,
			problems: problems.filter((problem) => problem.severity === 'problem').length,
		},
		...(full.error !== undefined ? { error: full.error } : {}),
	}
}
