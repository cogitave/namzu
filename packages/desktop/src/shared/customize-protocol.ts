/**
 * What the Customize page reads from the engine: every skill with its state, place and use, one
 * skill's files and a text file from its folder, and what a plugin's manifest says it brings. The
 * engine answers these over its own methods; every reader here accepts only the shape it expects,
 * caps what it keeps and drops the rest, so an answer from another version never reaches a screen
 * as it came.
 */

const record = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined

const short = (value: unknown, max: number): string | undefined =>
	typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined

const count = (value: unknown, max = 1_000_000): number | undefined =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0
		? Math.min(Math.floor(value), max)
		: undefined

/** A time in ISO form, or nothing. */
const isoTime = (value: unknown): string | undefined => {
	const text = short(value, 40)
	return text && !Number.isNaN(Date.parse(text)) ? text : undefined
}

export const SKILL_CATALOG_MAX = 500
export const SKILL_FILES_MAX = 200
export const SKILL_DESCRIPTION_MAX = 1_024
export const SKILL_FILE_TEXT_MAX = 256 * 1024
export const SKILL_NAME_MAX = 64

/** How a skill is offered: to everyone, to the person only, by name only, or not at all. */
export type SkillCatalogState = 'on' | 'name-only' | 'user-only' | 'off'

const STATES: readonly SkillCatalogState[] = ['on', 'name-only', 'user-only', 'off']

export interface SkillCatalogEntryView {
	name: string
	description: string
	/** The folder family (`system`, `user`, `agents-user`, `project`, ...) or `plugin`. */
	tier: string
	/** The tier in the person's words: `built-in`, `user`, `project, shared`, `plugin` and so on. */
	place: string
	/** The plugin's name, when the skill came with one. */
	plugin?: string
	state: SkillCatalogState
	updatedAt?: string
	fileCount: number
	uses7d?: number
	lastUsedAt?: string
	uses?: number
	removable: boolean
}

export interface SkillCatalogView {
	skills: SkillCatalogEntryView[]
	/** The engine can add, make and remove skills; set by main, absent from an older answer. */
	canManage?: boolean
}

export function readSkillCatalog(value: unknown): SkillCatalogView {
	const list = record(value)?.skills
	const skills: SkillCatalogEntryView[] = []
	if (Array.isArray(list))
		for (const item of list.slice(0, SKILL_CATALOG_MAX)) {
			const row = record(item)
			const name = short(row?.name, 200)
			const tier = short(row?.tier, 40)
			const place = short(row?.place, 60)
			const state = STATES.find((candidate) => candidate === row?.state)
			if (!row || !name || !tier || !place || !state) continue
			if (skills.some((skill) => skill.name === name)) continue
			const description =
				typeof row.description === 'string' ? row.description.slice(0, SKILL_DESCRIPTION_MAX) : ''
			const plugin = short(row.plugin, 200)
			const updatedAt = isoTime(row.updatedAt)
			const lastUsedAt = isoTime(row.lastUsedAt)
			const uses7d = count(row.uses7d)
			const uses = count(row.uses)
			skills.push({
				name,
				description,
				tier,
				place,
				...(plugin ? { plugin } : {}),
				state,
				...(updatedAt ? { updatedAt } : {}),
				fileCount: Math.min(count(row.fileCount) ?? 0, SKILL_FILES_MAX),
				...(uses7d !== undefined ? { uses7d } : {}),
				...(lastUsedAt ? { lastUsedAt } : {}),
				...(uses !== undefined ? { uses } : {}),
				removable: row.removable === true,
			})
		}
	return { skills }
}

export interface SkillFileView {
	path: string
	size: number
}

export interface SkillFilesView {
	files: SkillFileView[]
}

export function readSkillFiles(value: unknown): SkillFilesView {
	const list = record(value)?.files
	const files: SkillFileView[] = []
	if (Array.isArray(list))
		for (const item of list.slice(0, SKILL_FILES_MAX)) {
			const row = record(item)
			const path = short(row?.path, 512)
			const size = count(row?.size, Number.MAX_SAFE_INTEGER)
			if (!path || size === undefined) continue
			if (path.startsWith('/') || path.includes('\0') || path.split(/[\\/]/).includes('..'))
				continue
			files.push({ path, size })
		}
	return { files }
}

export interface SkillFileTextView {
	text: string
	truncated: boolean
}

/** The engine's answer, or null when it is not the shape asked for. */
export function readSkillFileText(value: unknown): SkillFileTextView | null {
	const row = record(value)
	if (!row || typeof row.text !== 'string' || typeof row.truncated !== 'boolean') return null
	return { text: row.text.slice(0, SKILL_FILE_TEXT_MAX), truncated: row.truncated }
}

/** The parts of a plugin's manifest the engine reports beside the inventory fields it always had. */
export interface PluginManifestView {
	skills?: { name: string; description: string }[]
	servers?: { name: string }[]
	author?: string
	updatedAt?: string
}

const PLUGIN_ITEMS_MAX = 100

/** Reads only the four added fields of one plugin entry; anything else in it is not touched here. */
export function readPluginManifestView(value: unknown): PluginManifestView {
	const row = record(value)
	if (!row) return {}
	const skills: { name: string; description: string }[] = []
	if (Array.isArray(row.skills))
		for (const item of row.skills.slice(0, PLUGIN_ITEMS_MAX)) {
			const skill = record(item)
			const name = short(skill?.name, 200)
			if (!skill || !name) continue
			skills.push({
				name,
				description:
					typeof skill.description === 'string'
						? skill.description.slice(0, SKILL_DESCRIPTION_MAX)
						: '',
			})
		}
	const servers: { name: string }[] = []
	if (Array.isArray(row.servers))
		for (const item of row.servers.slice(0, PLUGIN_ITEMS_MAX)) {
			const name = short(record(item)?.name, 200)
			if (name) servers.push({ name })
		}
	const author = short(row.author, 200)
	const updatedAt = isoTime(row.updatedAt)
	return {
		...(skills.length > 0 ? { skills } : {}),
		...(servers.length > 0 ? { servers } : {}),
		...(author ? { author } : {}),
		...(updatedAt ? { updatedAt } : {}),
	}
}

/**
 * An inventory whose plugin entries carry only valid manifest fields: the four added ones are
 * read through {@link readPluginManifestView}, every other field is left as it came.
 */
export function withManifestDetails<T extends { plugins: readonly unknown[] }>(view: T): T {
	if (!Array.isArray(view?.plugins)) return view
	return {
		...view,
		plugins: view.plugins.map((entry) => {
			const row = record(entry)
			if (!row) return entry
			const { skills: _s, servers: _v, author: _a, updatedAt: _u, ...rest } = row
			return { ...rest, ...readPluginManifestView(row) }
		}),
	}
}

export const SKILL_STAGE_ITEMS_MAX = 20
export const SKILL_STAGE_LINES_MAX = 20
const LINE_MAX = 300

/** Where a skill goes. */
export type SkillScope = 'user' | 'project'
const scopeOf = (value: unknown): SkillScope | undefined =>
	value === 'user' || value === 'project' ? value : undefined

/** One thing the person chose: the path goes back to `stageSkills`; with `error` it cannot be added. */
export interface SkillPathChoiceView {
	fileName: string
	path?: string
	kind?: 'file' | 'folder'
	error?: string
}

/** One thing the person chose to add, as the engine read it and before anything is written. */
export interface SkillStageItemView {
	fileName: string
	kind: 'file' | 'folder'
	name?: string
	description?: string
	files?: number
	bytes?: number
	/** What was kept, changed or left out. */
	findings: string[]
	/** What it can run or pre-approve; shown before a yes. */
	grants: string[]
	scripts: string[]
	/** The places that already hold a skill of this name. */
	collides?: SkillScope[]
	error?: string
}

export interface SkillStageView {
	stageId: string
	expiresAt: string
	items: SkillStageItemView[]
}

const lines = (value: unknown, max = SKILL_STAGE_LINES_MAX): string[] =>
	Array.isArray(value)
		? value
				.filter((item): item is string => typeof item === 'string' && item.length > 0)
				.slice(0, max)
				.map((item) => item.slice(0, LINE_MAX))
		: []

/** The engine's answer to staging, or null when it is not the shape asked for. */
export function readSkillStage(value: unknown): SkillStageView | null {
	const row = record(value)
	const stageId = short(row?.stageId, 100)
	const expiresAt = isoTime(row?.expiresAt)
	if (!row || !stageId || !expiresAt || !Array.isArray(row.items)) return null
	const items: SkillStageItemView[] = []
	for (const raw of row.items.slice(0, SKILL_STAGE_ITEMS_MAX)) {
		const item = record(raw)
		const fileName = short(item?.fileName, 300)
		const kind = item?.kind === 'file' || item?.kind === 'folder' ? item.kind : undefined
		if (!item || !fileName || !kind) continue
		const name = short(item.name, SKILL_NAME_MAX)
		const description =
			typeof item.description === 'string'
				? item.description.slice(0, SKILL_DESCRIPTION_MAX)
				: undefined
		const files = count(item.files, SKILL_FILES_MAX * 3)
		const bytes = count(item.bytes, Number.MAX_SAFE_INTEGER)
		const collides = Array.isArray(item.collides)
			? [...new Set(item.collides.map(scopeOf).filter((s): s is SkillScope => s !== undefined))]
			: []
		const error = short(item.error, LINE_MAX)
		items.push({
			fileName,
			kind,
			...(name ? { name } : {}),
			...(description !== undefined ? { description } : {}),
			...(files !== undefined ? { files } : {}),
			...(bytes !== undefined ? { bytes } : {}),
			findings: lines(item.findings),
			grants: lines(item.grants),
			scripts: lines(item.scripts, 50),
			...(collides.length > 0 ? { collides } : {}),
			...(error ? { error } : {}),
		})
	}
	return { stageId, expiresAt, items }
}

export interface SkillInstallResultView {
	name: string
	outcome: 'added' | 'replaced' | 'failed'
	path?: string
	error?: string
}

export interface SkillInstallView {
	results: SkillInstallResultView[]
	note?: string
}

export function readSkillInstall(value: unknown): SkillInstallView | null {
	const row = record(value)
	if (!row || !Array.isArray(row.results)) return null
	const results: SkillInstallResultView[] = []
	for (const raw of row.results.slice(0, SKILL_STAGE_ITEMS_MAX)) {
		const item = record(raw)
		const name = short(item?.name, 200)
		const outcome =
			item?.outcome === 'added' || item?.outcome === 'replaced' || item?.outcome === 'failed'
				? item.outcome
				: undefined
		if (!item || !name || !outcome) continue
		const path = short(item.path, 1024)
		const error = short(item.error, LINE_MAX)
		results.push({
			name,
			outcome,
			...(path ? { path } : {}),
			...(error ? { error } : {}),
		})
	}
	const note = short(row.note, LINE_MAX)
	return { results, ...(note ? { note } : {}) }
}

export interface SkillCreateView {
	outcome: 'created' | 'exists' | 'failed'
	path?: string
	error?: string
	note?: string
}

export function readSkillCreate(value: unknown): SkillCreateView | null {
	const row = record(value)
	const outcome =
		row?.outcome === 'created' || row?.outcome === 'exists' || row?.outcome === 'failed'
			? row.outcome
			: undefined
	if (!row || !outcome) return null
	const path = short(row.path, 1024)
	const error = short(row.error, LINE_MAX)
	const note = short(row.note, LINE_MAX)
	return {
		outcome,
		...(path ? { path } : {}),
		...(error ? { error } : {}),
		...(note ? { note } : {}),
	}
}

export interface SkillRemoveView {
	/** `removed`, or why not: `refused`, `unsafe`, `not-found`, `failed`... */
	outcome: string
	backup?: string
	error?: string
}

export function readSkillRemove(value: unknown): SkillRemoveView | null {
	const row = record(value)
	const outcome = short(row?.outcome, 40)
	if (!row || !outcome) return null
	const backup = short(row.backup, 1024)
	const error = short(row.error, LINE_MAX)
	return {
		outcome,
		...(backup ? { backup } : {}),
		...(error ? { error } : {}),
	}
}

/** What a skill the person writes in a form may hold, as the engine also checks it. */
export const SKILL_FORM_LIMITS = {
	name: SKILL_NAME_MAX,
	description: SKILL_DESCRIPTION_MAX,
	instructions: 64 * 1024,
} as const

/** The staged paths the app may ask the engine to read at once. */
export const SKILL_ADD_PATHS_MAX = 20

// ---------------------------------------------------------------------------
// Marketplaces and plugins
// ---------------------------------------------------------------------------

export const PLUGIN_LIST_MAX = 100
export const PLUGIN_FINDINGS_MAX = 50
const PLUGIN_TEXT_MAX = 20_000

/** Where a plugin's record lives: for everyone here, for this folder (shared), or for this folder on this computer. */
export type PluginScope = 'user' | 'project' | 'local'
const pluginScopeOf = (value: unknown): PluginScope | undefined =>
	value === 'user' || value === 'project' || value === 'local' ? value : undefined

const textList = (value: unknown, max = PLUGIN_LIST_MAX): string[] =>
	Array.isArray(value)
		? value
				.filter((item): item is string => typeof item === 'string' && item.length > 0)
				.slice(0, max)
				.map((item) => item.slice(0, LINE_MAX))
		: []

const line = (value: unknown): string | undefined => {
	const text = typeof value === 'string' && value.length > 0 ? value.slice(0, LINE_MAX) : undefined
	return text
}

/** What an address would be, read from its text alone. `error` set means it cannot be used. */
export interface MarketplacePreviewView {
	source?: string
	kind?: string
	remote?: boolean
	notice?: string
	blocked?: string
	error?: string
}

export function readMarketplacePreview(value: unknown): MarketplacePreviewView | null {
	const row = record(value)
	if (!row) return null
	const error = line(row.error)
	if (error) return { error }
	const source = line(row.source)
	const kind = short(row.kind, 40)
	if (!source || !kind || typeof row.remote !== 'boolean') return null
	const notice = typeof row.notice === 'string' ? row.notice.slice(0, 2_000) : undefined
	const blocked = line(row.blocked)
	return {
		source,
		kind,
		remote: row.remote,
		...(notice ? { notice } : {}),
		...(blocked ? { blocked } : {}),
	}
}

export interface MarketplaceAddView {
	name: string
	plugins: number
	outcome: 'added' | 'declared' | 'already-added'
	warnings: string[]
}

export function readMarketplaceAdd(value: unknown): MarketplaceAddView | null {
	const row = record(value)
	const name = short(row?.name, 64)
	const plugins = count(row?.plugins, 10_000)
	const outcome =
		row?.outcome === 'added' || row?.outcome === 'declared' || row?.outcome === 'already-added'
			? row.outcome
			: undefined
	if (!row || !name || plugins === undefined || !outcome) return null
	return { name, plugins, outcome, warnings: textList(row.warnings, PLUGIN_FINDINGS_MAX) }
}

export interface MarketplaceRowView {
	name: string
	source: string
	kind: string
	lastUpdated?: string
	autoUpdate: boolean
	plugins: number | null
	installed: number
	problem?: string
}

export interface MarketplaceListView {
	marketplaces: MarketplaceRowView[]
	declaredByProject: { name: string; declaredBy: 'project' | 'local' }[]
	problems: string[]
}

export function readMarketplaceList(value: unknown): MarketplaceListView | null {
	const row = record(value)
	if (!row || !Array.isArray(row.marketplaces)) return null
	const marketplaces: MarketplaceRowView[] = []
	for (const raw of row.marketplaces.slice(0, PLUGIN_LIST_MAX)) {
		const item = record(raw)
		const name = short(item?.name, 64)
		const source = line(item?.source)
		const kind = short(item?.kind, 40)
		if (!item || !name || !source || !kind) continue
		const lastUpdated = isoTime(item.lastUpdated)
		const problem = line(item.problem)
		marketplaces.push({
			name,
			source,
			kind,
			...(lastUpdated ? { lastUpdated } : {}),
			autoUpdate: item.autoUpdate === true,
			plugins: count(item.plugins, 10_000) ?? null,
			installed: count(item.installed, 10_000) ?? 0,
			...(problem ? { problem } : {}),
		})
	}
	const declaredByProject: MarketplaceListView['declaredByProject'] = []
	if (Array.isArray(row.declaredByProject))
		for (const raw of row.declaredByProject.slice(0, PLUGIN_LIST_MAX)) {
			const item = record(raw)
			const name = short(item?.name, 64)
			if (!name || (item?.declaredBy !== 'project' && item?.declaredBy !== 'local')) continue
			declaredByProject.push({ name, declaredBy: item.declaredBy })
		}
	return { marketplaces, declaredByProject, problems: textList(row.problems, PLUGIN_FINDINGS_MAX) }
}

export interface MarketplaceRemoveView {
	name: string
	removedPlugins: string[]
}

export function readMarketplaceRemove(value: unknown): MarketplaceRemoveView | null {
	const row = record(value)
	const name = short(row?.name, 64)
	if (!row || row.outcome !== 'removed' || !name) return null
	return { name, removedPlugins: textList(row.removedPlugins) }
}

export interface MarketplaceUpdateView {
	results: { name: string; outcome: 'updated' | 'failed'; plugins?: number; error?: string }[]
}

export function readMarketplaceUpdate(value: unknown): MarketplaceUpdateView | null {
	const row = record(value)
	if (!row || !Array.isArray(row.results)) return null
	const results: MarketplaceUpdateView['results'] = []
	for (const raw of row.results.slice(0, PLUGIN_LIST_MAX)) {
		const item = record(raw)
		const name = short(item?.name, 64)
		const outcome =
			item?.outcome === 'updated' || item?.outcome === 'failed' ? item.outcome : undefined
		if (!item || !name || !outcome) continue
		const plugins = count(item.plugins, 10_000)
		const error = line(item.error)
		results.push({
			name,
			outcome,
			...(plugins !== undefined ? { plugins } : {}),
			...(error ? { error } : {}),
		})
	}
	return { results }
}

export interface MarketplacePluginView {
	name: string
	id: string
	description?: string
	version?: string
	author?: string
	installable: boolean
	reason?: string
	installedAt: PluginScope[]
}

export interface MarketplaceAvailableView {
	marketplace: string
	plugins: MarketplacePluginView[]
	warnings: string[]
}

export function readMarketplaceAvailable(value: unknown): MarketplaceAvailableView | null {
	const row = record(value)
	const marketplace = short(row?.marketplace, 64)
	if (!row || !marketplace || !Array.isArray(row.plugins)) return null
	const plugins: MarketplacePluginView[] = []
	for (const raw of row.plugins.slice(0, 500)) {
		const item = record(raw)
		const name = short(item?.name, 200)
		const id = short(item?.id, 200)
		if (!item || !name || !id || typeof item.installable !== 'boolean') continue
		const description =
			typeof item.description === 'string'
				? item.description.slice(0, SKILL_DESCRIPTION_MAX)
				: undefined
		const version = short(item.version, 64)
		const author = short(item.author, 200)
		const reason = line(item.reason)
		plugins.push({
			name,
			id,
			...(description ? { description } : {}),
			...(version ? { version } : {}),
			...(author ? { author } : {}),
			installable: item.installable,
			...(reason ? { reason } : {}),
			installedAt: Array.isArray(item.installedAt)
				? [
						...new Set(
							item.installedAt.map(pluginScopeOf).filter((s): s is PluginScope => s !== undefined),
						),
					]
				: [],
		})
	}
	return { marketplace, plugins, warnings: textList(row.warnings, PLUGIN_FINDINGS_MAX) }
}

/** The consent surface: every kind of thing a plugin runs on this computer. */
export interface PluginSurfaceView {
	hooks: { event: string; matcher?: string; type: string; run: string; from?: string }[]
	fileHooks: { kind: string; name: string; event: string; type: string; run: string }[]
	mcpLocal: {
		name: string
		command: string
		args: string[]
		envNames: string[]
		needsSetup?: true
	}[]
	mcpRemote: {
		name: string
		origin: string
		transport: string
		sendsEnv: string[]
		headers: string[]
		needsSetup?: true
	}[]
	modules: { path: string; declares?: string[]; isolated?: boolean; refused?: string }[]
	allowedTools: { kind: string; name: string; tools: string[] }[]
	scripts: { path: string; bytes: number; exec: boolean }[]
	scriptsTotal: number
	unpinnedDownload: boolean
}

function rows<T>(value: unknown, each: (item: Record<string, unknown>) => T | undefined): T[] {
	const out: T[] = []
	if (!Array.isArray(value)) return out
	for (const raw of value.slice(0, PLUGIN_LIST_MAX)) {
		const item = record(raw)
		const read = item ? each(item) : undefined
		if (read !== undefined) out.push(read)
	}
	return out
}

export function readPluginSurface(value: unknown): PluginSurfaceView | null {
	const row = record(value)
	if (!row) return null
	return {
		hooks: rows(row.hooks, (item) => {
			const event = line(item.event)
			const type = short(item.type, 20)
			const run = line(item.run)
			if (!event || !type || run === undefined) return undefined
			const matcher = line(item.matcher)
			const from = line(item.from)
			return { event, ...(matcher ? { matcher } : {}), type, run, ...(from ? { from } : {}) }
		}),
		fileHooks: rows(row.fileHooks, (item) => {
			const kind = short(item.kind, 20)
			const name = line(item.name)
			const event = line(item.event)
			const type = short(item.type, 20)
			const run = line(item.run)
			if (!kind || !name || !event || !type || run === undefined) return undefined
			return { kind, name, event, type, run }
		}),
		mcpLocal: rows(row.mcpLocal, (item) => {
			const name = line(item.name)
			const command = line(item.command)
			if (!name || !command) return undefined
			return {
				name,
				command,
				args: textList(item.args),
				envNames: textList(item.envNames),
				...(item.needsSetup === true ? { needsSetup: true as const } : {}),
			}
		}),
		mcpRemote: rows(row.mcpRemote, (item) => {
			const name = line(item.name)
			const origin = line(item.origin)
			const transport = short(item.transport, 20)
			if (!name || !origin || !transport) return undefined
			return {
				name,
				origin,
				transport,
				sendsEnv: textList(item.sendsEnv),
				headers: textList(item.headers),
				...(item.needsSetup === true ? { needsSetup: true as const } : {}),
			}
		}),
		modules: rows(row.modules, (item) => {
			const path = line(item.path)
			if (!path) return undefined
			const refused = line(item.refused)
			return {
				path,
				...(Array.isArray(item.declares) ? { declares: textList(item.declares) } : {}),
				...(typeof item.isolated === 'boolean' ? { isolated: item.isolated } : {}),
				...(refused ? { refused } : {}),
			}
		}),
		allowedTools: rows(row.allowedTools, (item) => {
			const kind = short(item.kind, 20)
			const name = line(item.name)
			if (!kind || !name) return undefined
			return { kind, name, tools: textList(item.tools) }
		}),
		scripts: rows(row.scripts, (item) => {
			const path = line(item.path)
			const bytes = count(item.bytes, Number.MAX_SAFE_INTEGER)
			if (!path || bytes === undefined) return undefined
			return { path, bytes, exec: item.exec === true }
		}),
		scriptsTotal: count(row.scriptsTotal, 1_000_000) ?? 0,
		unpinnedDownload: row.unpinnedDownload === true,
	}
}

export interface PluginFindingView {
	level: string
	code: string
	field?: string
	message: string
}

function readFindings(value: unknown): PluginFindingView[] {
	const out: PluginFindingView[] = []
	if (!Array.isArray(value)) return out
	for (const raw of value.slice(0, PLUGIN_FINDINGS_MAX)) {
		const item = record(raw)
		const level = short(item?.level, 20)
		const code = short(item?.code, 80)
		const message = line(item?.message)
		if (!item || !level || !code || !message) continue
		const fieldName = line(item.field)
		out.push({ level, code, ...(fieldName ? { field: fieldName } : {}), message })
	}
	return out
}

/** What a plugin would do, with the digest the install must send back. Nothing is installed yet. */
export interface PluginPlanView {
	planId: string
	digest: string
	id: string
	name: string
	version: string
	layout: 'common' | 'namzu'
	scope: PluginScope
	components: { skills: string[]; commands: string[]; agents: string[] }
	surface: PluginSurfaceView
	findings: PluginFindingView[]
	warnings: string[]
	/** The same text the command line shows, ending with the digest. */
	preview: string
	installed?: { version: string | null }
	loadingOn: boolean
	expiresAt: string
}

export function readPluginPlan(value: unknown): PluginPlanView | null {
	const row = record(value)
	const planId = short(row?.planId, 100)
	const digest =
		typeof row?.digest === 'string' && /^[0-9a-f]{64}$/.test(row.digest) ? row.digest : undefined
	const id = short(row?.id, 200)
	const name = short(row?.name, 200)
	const version = short(row?.version, 100)
	const scope = pluginScopeOf(row?.scope)
	const expiresAt = isoTime(row?.expiresAt)
	const surface = readPluginSurface(row?.surface)
	const components = record(row?.components)
	const preview =
		typeof row?.preview === 'string' ? row.preview.slice(0, PLUGIN_TEXT_MAX) : undefined
	if (
		!row ||
		!planId ||
		!digest ||
		!id ||
		!name ||
		!version ||
		!scope ||
		!expiresAt ||
		!surface ||
		!components ||
		preview === undefined ||
		typeof row.loadingOn !== 'boolean'
	)
		return null
	const installed = record(row.installed)
	return {
		planId,
		digest,
		id,
		name,
		version,
		layout: row.layout === 'common' ? 'common' : 'namzu',
		scope,
		components: {
			skills: textList(components.skills),
			commands: textList(components.commands),
			agents: textList(components.agents),
		},
		surface,
		findings: readFindings(row.findings),
		warnings: textList(row.warnings, PLUGIN_FINDINGS_MAX),
		preview,
		...(installed ? { installed: { version: line(installed.version) ?? null } } : {}),
		loadingOn: row.loadingOn,
		expiresAt,
	}
}

export interface PluginStageView {
	stageId: string
	name: string
	version: string
	expiresAt: string
}

export function readPluginStage(value: unknown): PluginStageView | null {
	const row = record(value)
	const stageId = short(row?.stageId, 100)
	const name = short(row?.name, 200)
	const version = short(row?.version, 100)
	const expiresAt = isoTime(row?.expiresAt)
	if (!row || !stageId || !name || !version || !expiresAt) return null
	return { stageId, name, version, expiresAt }
}

export interface PluginInstallView {
	id: string
	outcome: 'installed' | 'already-installed'
	loading: 'on' | 'off'
	message: string
	notes: string[]
}

export function readPluginInstall(value: unknown): PluginInstallView | null {
	const row = record(value)
	const id = short(row?.id, 200)
	const outcome =
		row?.outcome === 'installed' || row?.outcome === 'already-installed' ? row.outcome : undefined
	const loading = row?.loading === 'on' || row?.loading === 'off' ? row.loading : undefined
	const message = line(row?.message)
	if (!row || !id || !outcome || !loading || !message) return null
	return { id, outcome, loading, message, notes: textList(row.notes, 10) }
}

export interface PluginEnableView {
	outcome: 'enabled' | 'disabled' | 'unchanged'
	id: string
	scope: PluginScope
	effective: { enabled: boolean; by?: PluginScope }
	loading: 'on' | 'off'
	note?: string
}

export function readPluginEnable(value: unknown): PluginEnableView | null {
	const row = record(value)
	const id = short(row?.id, 200)
	const scope = pluginScopeOf(row?.scope)
	const outcome =
		row?.outcome === 'enabled' || row?.outcome === 'disabled' || row?.outcome === 'unchanged'
			? row.outcome
			: undefined
	const effective = record(row?.effective)
	if (!row || !id || !scope || !outcome || !effective || typeof effective.enabled !== 'boolean')
		return null
	const by = pluginScopeOf(effective.by)
	const note = line(row.note)
	return {
		outcome,
		id,
		scope,
		effective: { enabled: effective.enabled, ...(by ? { by } : {}) },
		loading: row.loading === 'on' ? 'on' : 'off',
		...(note ? { note } : {}),
	}
}

export interface PluginUpdateCheckView {
	id: string
	current: string | null
	latest: string
	upToDate: boolean
	changesExecutable: boolean
}

export function readPluginUpdateCheck(value: unknown): PluginUpdateCheckView | null {
	const row = record(value)
	const id = short(row?.id, 200)
	const latest = short(row?.latest, 100)
	if (!row || !id || !latest || typeof row.upToDate !== 'boolean') return null
	return {
		id,
		current: line(row.current) ?? null,
		latest,
		upToDate: row.upToDate,
		changesExecutable: row.changesExecutable === true,
	}
}

/** An update, or the question it needs answered first (`needs-consent`, with the digest to send back). */
export interface PluginUpdateView {
	outcome: 'updated' | 'up-to-date' | 'needs-consent'
	id: string
	from: string | null
	to: string
	message?: string
	digest?: string
	changes?: string[]
	surface?: PluginSurfaceView
	preview?: string
}

export function readPluginUpdate(value: unknown): PluginUpdateView | null {
	const row = record(value)
	const id = short(row?.id, 200)
	const to = short(row?.to, 100)
	const outcome =
		row?.outcome === 'updated' || row?.outcome === 'up-to-date' || row?.outcome === 'needs-consent'
			? row.outcome
			: undefined
	if (!row || !id || !to || !outcome) return null
	const message = line(row.message)
	const digest =
		typeof row.digest === 'string' && /^[0-9a-f]{64}$/.test(row.digest) ? row.digest : undefined
	if (outcome === 'needs-consent' && !digest) return null
	const surface = readPluginSurface(row.surface)
	const preview =
		typeof row.preview === 'string' ? row.preview.slice(0, PLUGIN_TEXT_MAX) : undefined
	return {
		outcome,
		id,
		from: line(row.from) ?? null,
		to,
		...(message ? { message } : {}),
		...(digest ? { digest } : {}),
		...(Array.isArray(row.changes) ? { changes: textList(row.changes, PLUGIN_FINDINGS_MAX) } : {}),
		...(surface ? { surface } : {}),
		...(preview !== undefined ? { preview } : {}),
	}
}

export interface PluginUninstallView {
	id: string
	scope: PluginScope
	dataKept: boolean
	dataDeleted: boolean
	remaining: number
}

export function readPluginUninstall(value: unknown): PluginUninstallView | null {
	const row = record(value)
	const id = short(row?.id, 200)
	const scope = pluginScopeOf(row?.scope)
	if (!row || row.outcome !== 'uninstalled' || !id || !scope) return null
	return {
		id,
		scope,
		dataKept: row.dataKept === true,
		dataDeleted: row.dataDeleted === true,
		remaining: count(row.remaining, 100) ?? 0,
	}
}

export function readOpCancel(value: unknown): { cancelled: boolean } | null {
	const row = record(value)
	return row && typeof row.cancelled === 'boolean' ? { cancelled: row.cancelled } : null
}

/** The notification a long step sends: which step (by the id the app gave it) and its phase. */
export const OP_PROGRESS_NOTIFICATION = 'namzu/ops/progress'
export interface OpProgressView {
	opId: string
	phase: 'checking' | 'downloading' | 'reading'
}

export function readOpProgress(value: unknown): OpProgressView | null {
	const row = record(value)
	const opId =
		typeof row?.opId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(row.opId) ? row.opId : undefined
	const phase =
		row?.phase === 'checking' || row?.phase === 'downloading' || row?.phase === 'reading'
			? row.phase
			: undefined
	return opId && phase ? { opId, phase } : null
}

/** An id the app picks for a long step it may want to stop. */
export const OP_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

/** What a plugin file or folder the person picks may be, as the engine also checks it. */
export const PLUGIN_ARCHIVE_MAX_BYTES = 200 * 1024 * 1024
