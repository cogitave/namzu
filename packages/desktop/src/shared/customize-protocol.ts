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
