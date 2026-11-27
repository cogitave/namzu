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
export const MARKETPLACE_READY_HINT = 'Enter an address to continue.'
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
	const { count, source, updated: when } = marketplaceSubParts(row, updated)
	return [count, source, when].filter(Boolean).join(' · ')
}

/** The three pieces of that line, so the page can keep the count and the freshness whole and shorten only the address. */
export function marketplaceSubParts(
	row: MarketplaceRowView,
	updated: string,
): { count: string; source: string; updated: string } {
	return {
		count:
			row.plugins === null
				? 'Not read yet'
				: `${row.plugins} ${row.plugins === 1 ? 'plugin' : 'plugins'}`,
		source: row.source,
		updated: updated ? `updated ${updated}` : '',
	}
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

export interface ConsentRow {
	text: string
	/** What would run, shown whole in monospace beside the text. */
	code?: string
}

export interface ConsentSection {
	id: 'adds' | 'runs' | 'left' | 'ignored' | 'tools'
	title: string
	muted?: boolean
	/** Each row as one plain sentence: the text the person says yes to. */
	lines: string[]
	/** The same rows with the runnable part apart, for the page to set in monospace. */
	rows: ConsentRow[]
}

const joinList = (items: readonly string[]): string => items.join(', ')

const EVENT_WORDS: Record<string, string> = {
	PreToolUse: 'Before a tool runs',
	PostToolUse: 'After a tool runs',
	SessionStart: 'When a conversation starts',
	SessionEnd: 'When a conversation ends',
	UserPromptSubmit: 'When you send a message',
	Stop: 'When a turn ends',
}

/** An event name in words: the known ones by their sense, the rest spaced out. */
export function eventWords(event: string): string {
	const pascal = event.replace(/(^|_)([a-z])/g, (_m, _u, c: string) => c.toUpperCase())
	const known = EVENT_WORDS[pascal]
	if (known) return known
	const spaced = event
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/_/g, ' ')
		.toLowerCase()
	return `On ${spaced}`
}

const sizeWords = (bytes: number): string =>
	bytes < 1024
		? `${bytes} B`
		: bytes < 1024 * 1024
			? `${Math.round(bytes / 1024)} KB`
			: `${(bytes / 1024 / 1024).toFixed(1)} MB`

const row = (text: string, code?: string): ConsentRow => (code ? { text, code } : { text })
const asLine = (item: ConsentRow): string => (item.code ? `${item.text}: ${item.code}` : item.text)
const section = (
	id: ConsentSection['id'],
	title: string,
	rows: ConsentRow[],
	muted?: boolean,
): ConsentSection => ({
	id,
	title,
	rows,
	lines: rows.map(asLine),
	...(muted ? { muted: true } : {}),
})

/** What a plugin adds, runs and ignores, each as plain lines: the text the person says yes to. */
export function consentSections(
	surface: PluginSurfaceView,
	components: PluginPlanView['components'] | undefined,
	findings: PluginPlanView['findings'],
): ConsentSection[] {
	const sections: ConsentSection[] = []
	const adds: ConsentRow[] = []
	if (components) {
		if (components.skills.length) adds.push(row(`Skills: ${joinList(components.skills)}`))
		if (components.commands.length) adds.push(row(`Commands: ${joinList(components.commands)}`))
		if (components.agents.length) adds.push(row(`Agents: ${joinList(components.agents)}`))
	}
	for (const tools of surface.allowedTools)
		adds.push(
			row(`${tools.name} may use ${tools.tools.length ? joinList(tools.tools) : 'no tools'}`),
		)
	if (adds.length) sections.push(section('adds', 'This plugin adds', adds))

	const runs: ConsentRow[] = []
	const kind = (type: string) =>
		type === 'command' ? '' : `${type[0]?.toUpperCase()}${type.slice(1)} `
	for (const hook of surface.hooks)
		runs.push(
			row(
				`${kind(hook.type)}${kind(hook.type) ? 'hook' : 'Hook'}: ${eventWords(hook.event)}${hook.matcher ? ` (${hook.matcher})` : ''}`,
				hook.run,
			),
		)
	for (const hook of surface.fileHooks)
		runs.push(
			row(
				`${kind(hook.type)}${kind(hook.type) ? 'hook' : 'Hook'} in ${hook.kind} ${hook.name}: ${eventWords(hook.event)}`,
				hook.run,
			),
		)
	for (const server of surface.mcpLocal) {
		const notes = [
			server.envNames.length ? `environment: ${joinList(server.envNames)}` : '',
			server.needsSetup ? 'needs setup: not started until its variables are set' : '',
		].filter(Boolean)
		runs.push(
			row(
				`Server ${server.name}${notes.length ? ` (${notes.join('; ')})` : ''}`,
				[server.command, ...server.args].join(' '),
			),
		)
	}
	for (const server of surface.mcpRemote) {
		const notes = ['asks you before it connects']
		if (server.sendsEnv.length)
			notes.push(`would send ${server.sendsEnv.map((name) => `$${name}`).join(', ')}`)
		if (server.headers.length) notes.push(`headers: ${joinList(server.headers)}`)
		if (server.needsSetup) notes.push('needs setup')
		runs.push(row(`Server ${server.name} (${notes.join('; ')})`, server.origin))
	}
	for (const module of surface.modules) {
		if (module.refused !== undefined)
			runs.push(row(`Module (not run: ${module.refused})`, module.path))
		else if (module.isolated === true)
			runs.push(
				row(
					`Module (runs in an isolated worker${module.declares?.length ? `; ${joinList(module.declares)}` : ''})`,
					module.path,
				),
			)
		else
			runs.push(
				row(
					'Module (JavaScript that runs inside the session; what it declares is not read before it runs)',
					module.path,
				),
			)
	}
	for (const script of surface.scripts)
		runs.push(
			row(`Script (${sizeWords(script.bytes)}${script.exec ? ', executable' : ''})`, script.path),
		)
	if (surface.scriptsTotal > surface.scripts.length)
		runs.push(row(`and ${surface.scriptsTotal - surface.scripts.length} more scripts it ships`))
	if (surface.unpinnedDownload)
		runs.push(row('It downloads code that is not pinned to one version.'))
	if (runs.length) sections.push(section('runs', 'Runs on this computer', runs))

	const left = findings.filter((f) => f.level === 'refused').map((f) => row(f.message))
	if (left.length) sections.push(section('left', 'Left out', left))
	const ignored = findings
		.filter((f) => f.level === 'ignored' || f.level === 'notUsed')
		.map((f) => row(f.message))
	if (ignored.length) sections.push(section('ignored', 'Not used by Namzu', ignored, true))
	return sections
}

/** A short form of the digest for small print: the first and last eight characters. */
export const shortDigest = (digest: string): string => `${digest.slice(0, 8)}…${digest.slice(-8)}`
