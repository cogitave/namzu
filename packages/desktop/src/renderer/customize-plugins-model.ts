import type {
	MarketplacePreviewView,
	MarketplaceRowView,
	PluginPlanView,
	PluginScope,
	PluginSurfaceView,
	PluginUpdateCheckView,
} from '../shared/customize-protocol.js'
import type { ComposerPlugin } from './composer-plugins.js'

/**
 * The words and rules of the plugin actions on the Customize page, as plain data: no React and no
 * engine call, so each rule can be tested alone.
 */

export const MARKETPLACE_NOTICE =
	'Only add marketplaces you trust. Namzu does not control their plugins, and their owners can change them later.'
export const MARKETPLACE_URL_HELP =
	'A GitHub owner/repo, a Git repository address, a marketplace.json address, or a folder on this computer.'
export const MARKETPLACE_URL_PLACEHOLDER = 'owner/repo or a Git address'
export const LOCAL_UPLOADS = 'local-uploads'

export const PLUGIN_UPLOAD_SUBTITLE =
	'Add a plugin to this computer from a .zip or .plugin file, or a folder.'
export const PLUGIN_UPLOAD_NOTICE =
	'Only upload plugins you trust. Namzu cannot check what they do.'
export const PLUGIN_DROP_TEXT = 'Drag and drop a plugin file here, or browse.'
export const PLUGIN_UPLOAD_HELP =
	'The archive must contain a plugin manifest (for the common layout, .claude-plugin/plugin.json), or a top-level SKILL.md.'
export const PLUGIN_UPLOAD_HINT = 'Choose a file to continue.'
export const PLUGIN_RUNS_WARNING =
	'Plugins run code on your computer, with access to your files. Install only what you trust.'
export const PLUGIN_LOADING_LABEL = 'Turn on plugin loading (needed for plugins to run)'
export const PLUGIN_ZIP_ONLY = 'Only .zip or .plugin files can be uploaded.'
export const PLUGIN_PROJECT_UNTRUSTED = 'Open a trusted project folder to install plugins there.'
export const UPDATE_FAILED = 'Couldn’t check for updates. Try again.'
export const UPLOADS_NO_UPDATES = 'Plugins you uploaded have no source to compare with.'
export const PLACED_NO_UPDATES = 'A plugin placed by hand has no source to compare with.'
export const PLACED_NOTE =
	'This plugin is a folder you placed in .namzu/plugins. Namzu will not delete it; remove the folder yourself.'
export const UPLOAD_ZIP_CAP = 'Only one plugin can be added at a time.'

export const PHASE_WORDS = {
	checking: 'Checking…',
	downloading: 'Downloading…',
	reading: 'Reading…',
} as const

/** A step id the window picks for a long step it may want to stop; 8 to 64 letters, digits, `_` and `-`. */
export function newOpId(prefix = 'op'): string {
	const random = Math.random().toString(36).slice(2, 12).padEnd(8, '0')
	return `${prefix}-${Date.now().toString(36)}-${random}`.slice(0, 64)
}

/** What the Add marketplace dialog says under the address, read from the preview. */
export function previewLine(
	view: MarketplacePreviewView | null | undefined,
): { tone: 'ok' | 'error'; text: string } | undefined {
	if (!view) return undefined
	if (view.error) return { tone: 'error', text: view.error }
	if (view.blocked) return { tone: 'error', text: view.blocked }
	if (!view.source) return undefined
	return { tone: 'ok', text: `Will add ${view.source}` }
}

export const marketplaceLetter = (name: string): string =>
	(name.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase()

/** `team-tools · 14 plugins · from /path`, as the Marketplaces row's second line. */
export function marketplaceSub(row: MarketplaceRowView, updated: string): string {
	const parts = [
		row.plugins === null
			? 'Not read yet'
			: `${row.plugins} ${row.plugins === 1 ? 'plugin' : 'plugins'}`,
		row.source,
	]
	if (updated) parts.push(`updated ${updated}`)
	return parts.join(' · ')
}

/** A group heading for the plugins Namzu installed, by the marketplace each came from. */
export function groupTitle(marketplace: string | undefined): string {
	if (!marketplace) return 'Installed'
	return marketplace === LOCAL_UPLOADS ? 'Uploaded' : `From ${marketplace}`
}

export interface PluginGroup {
	key: string
	title: string
	plugins: ComposerPlugin[]
}

/** The installed plugins in groups: one per marketplace, plugins without one together first. */
export function groupPlugins(plugins: readonly ComposerPlugin[]): PluginGroup[] {
	const groups = new Map<string, PluginGroup>()
	for (const plugin of plugins) {
		const key = plugin.marketplace ?? ''
		const group = groups.get(key) ?? { key, title: groupTitle(plugin.marketplace), plugins: [] }
		group.plugins.push(plugin)
		groups.set(key, group)
	}
	return [...groups.values()].sort((a, b) =>
		a.key === b.key ? 0 : a.key === '' ? -1 : b.key === '' ? 1 : a.title.localeCompare(b.title),
	)
}

/** The place whose record turns the plugin on or off: where it is installed, preferring where it is listed. */
export function recordScope(plugin: ComposerPlugin): PluginScope | undefined {
	const places = plugin.installed ?? []
	if (places.length === 0) return undefined
	return places.includes(plugin.scope) ? plugin.scope : places[0]
}

/** Whether Namzu installed it, so it can be turned off in its record, updated and removed. */
export const isManaged = (plugin: ComposerPlugin): boolean =>
	Boolean(plugin.id && recordScope(plugin))

/** Why a plugin has no Check for updates, in words; nothing when it has one. */
export function noUpdateReason(plugin: ComposerPlugin): string | undefined {
	if (!plugin.id) return PLACED_NO_UPDATES
	if (plugin.marketplace === LOCAL_UPLOADS) return UPLOADS_NO_UPDATES
	return undefined
}

export type UpdateState =
	| { kind: 'checking' }
	| { kind: 'failed' }
	| { kind: 'current'; version: string }
	| { kind: 'available'; version: string; changesExecutable: boolean }
	| { kind: 'updating' }

export function updateState(check: PluginUpdateCheckView): UpdateState {
	return check.upToDate
		? { kind: 'current', version: check.current ?? check.latest }
		: { kind: 'available', version: check.latest, changesExecutable: check.changesExecutable }
}

/** What a row says about its last check. */
export function updateWords(state: UpdateState | undefined): string | undefined {
	switch (state?.kind) {
		case 'checking':
			return 'Checking for updates'
		case 'failed':
			return UPDATE_FAILED
		case 'current':
			return 'Up to date'
		case 'available':
			return `Version ${state.version} is available`
		case 'updating':
			return 'Updating'
		default:
			return undefined
	}
}

export const removePluginTitle = 'Remove plugin?'
export const removePluginBody = (name: string): string =>
	`"${name}" will be removed from this computer. You can add it again from its marketplace.`
export const DELETE_DATA_LABEL = 'Also delete its saved data'
export const removeMarketplaceTitle = 'Remove marketplace?'
export function removeMarketplaceBody(name: string, installed: readonly string[]): string {
	if (installed.length === 0)
		return `"${name}" will be removed. No plugin you installed came from it.`
	return `This also removes ${installed.length} ${installed.length === 1 ? 'plugin' : 'plugins'} you installed from it. Their saved data is kept.`
}
export const turnOffTitle = (name: string): string => `Turn off "${name}"?`
export const TURN_OFF_BODY =
	'Its skills, commands and servers stop being offered in new conversations.'

/** The plugins installed from one marketplace, by name. */
export const installedFrom = (plugins: readonly ComposerPlugin[], marketplace: string): string[] =>
	plugins.filter((p) => p.marketplace === marketplace).map((p) => p.name)

export interface ConsentSection {
	id: 'adds' | 'runs' | 'ignored' | 'tools'
	title: string
	muted?: boolean
	lines: string[]
}

const joinList = (items: readonly string[]): string => items.join(', ')

/** What a plugin adds, runs and ignores, each as plain lines: the text the person says yes to. */
export function consentSections(
	surface: PluginSurfaceView,
	components: PluginPlanView['components'] | undefined,
	findings: PluginPlanView['findings'],
): ConsentSection[] {
	const sections: ConsentSection[] = []
	const adds: string[] = []
	if (components) {
		if (components.skills.length) adds.push(`Skills: ${joinList(components.skills)}`)
		if (components.commands.length) adds.push(`Commands: ${joinList(components.commands)}`)
		if (components.agents.length) adds.push(`Agents: ${joinList(components.agents)}`)
	}
	for (const tools of surface.allowedTools)
		adds.push(`${tools.name} may use ${tools.tools.length ? joinList(tools.tools) : 'no tools'}`)
	if (adds.length) sections.push({ id: 'adds', title: 'This plugin adds', lines: adds })

	const runs: string[] = []
	for (const hook of surface.hooks)
		runs.push(`Hook on ${hook.event}${hook.matcher ? ` (${hook.matcher})` : ''}: ${hook.run}`)
	for (const hook of surface.fileHooks)
		runs.push(`${hook.kind} ${hook.name}, hook on ${hook.event}: ${hook.run}`)
	for (const server of surface.mcpLocal) {
		const env = server.envNames.length ? `, with ${joinList(server.envNames)}` : ''
		runs.push(`Server ${server.name}: ${[server.command, ...server.args].join(' ')}${env}`)
	}
	for (const server of surface.mcpRemote) {
		const sends = [...server.sendsEnv, ...server.headers]
		runs.push(
			`Server ${server.name} at ${server.origin}${sends.length ? `, sends ${joinList(sends)}` : ''}`,
		)
	}
	for (const module of surface.modules)
		runs.push(
			module.refused ? `${module.path} (refused: ${module.refused})` : `Module ${module.path}`,
		)
	if (surface.scriptsTotal > 0)
		runs.push(
			`${surface.scriptsTotal} ${surface.scriptsTotal === 1 ? 'script' : 'scripts'} it ships${surface.scripts.length < surface.scriptsTotal ? ` (first ${surface.scripts.length} listed)` : ''}`,
		)
	if (surface.unpinnedDownload) runs.push('It downloads code that is not pinned to one version.')
	if (runs.length) sections.push({ id: 'runs', title: 'Runs on this computer', lines: runs })

	const ignored = findings.filter((f) => f.level === 'ignored').map((f) => f.message)
	if (ignored.length)
		sections.push({ id: 'ignored', title: 'Not used by Namzu', muted: true, lines: ignored })
	return sections
}

/** A short form of the digest for small print: the first and last eight characters. */
export const shortDigest = (digest: string): string => `${digest.slice(0, 8)}…${digest.slice(-8)}`
