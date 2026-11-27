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
