import {
	closeSync,
	lstatSync,
	openSync,
	readSync,
	readdirSync,
	realpathSync,
	statSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { SkillsConfig } from '../config/schema.js'
import { type SkillState, skillStateOf } from './overrides.js'
import { type SkillTier, discoverSkillRoster, skillTierLabel } from './store.js'
import { readSkillUsage } from './usage.js'

/** One skill as the Customize page lists it. */
export interface SkillCatalogEntry {
	readonly name: string
	/** Cut to {@link DESCRIPTION_MAX} characters. */
	readonly description: string
	/** The folder family it came from; `plugin` for a skill a plugin ships. */
	readonly tier: SkillTier | 'plugin'
	/** The tier in the person's words: `built-in`, `user`, `user, shared`, `project`, `plugin`. */
	readonly place: string
	/** The plugin's name, when the skill came with one. */
	readonly plugin?: string
	readonly state: SkillState
	/** The `SKILL.md` modification time, in ISO form. */
	readonly updatedAt?: string
	readonly fileCount: number
	readonly uses7d?: number
	readonly lastUsedAt?: string
	readonly uses?: number
	/** True where the folder belongs to the person: the user and project tiers. */
	readonly removable: boolean
}

/** What the plugin list gives the catalog for each plugin that ships skills. */
export interface CatalogPlugin {
	readonly name: string
	readonly startupEnabled?: boolean
	readonly updatedAt?: string
	readonly skills?: readonly { readonly name: string; readonly description: string }[]
}

export const DESCRIPTION_MAX = 1_024
export const MAX_SKILL_FILES = 200
export const MAX_FILE_BYTES = 256 * 1024
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const REMOVABLE: ReadonlySet<SkillTier> = new Set(['user', 'project'])

export interface CatalogOptions {
	readonly cwd: string
	readonly includeProject: boolean
	readonly config?: SkillsConfig
	readonly plugins?: readonly CatalogPlugin[]
	readonly home?: string
	readonly systemDir?: string
	readonly now?: number
}

/** The folder under `root` the walk may enter: not a dot-folder, not a link leaving the folder. */
function insideReal(rootReal: string, target: string): boolean {
	const rel = relative(rootReal, target)
	return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** The files of a skill folder, relative with `/` separators, at most `limit`; never leaving the folder. */
export function listSkillFolderFiles(
	folder: string,
	limit = MAX_SKILL_FILES,
): { path: string; size: number }[] {
	let rootReal: string
	try {
		rootReal = realpathSync(folder)
	} catch {
		return []
	}
	const out: { path: string; size: number }[] = []
	const walk = (dir: string, prefix: string): void => {
		let names: string[]
		try {
			names = readdirSync(dir).sort()
		} catch {
			return
		}
		for (const name of names) {
			if (out.length >= limit) return
			const full = join(dir, name)
			let info: ReturnType<typeof lstatSync>
			try {
				info = lstatSync(full)
			} catch {
				continue
			}
			const rel = prefix === '' ? name : `${prefix}/${name}`
			if (info.isSymbolicLink()) {
				// A link is followed only to a file that stays inside the folder; a linked folder is skipped.
				try {
					const real = realpathSync(full)
					if (!insideReal(rootReal, real)) continue
					const target = statSync(real)
					if (target.isFile()) out.push({ path: rel, size: target.size })
				} catch {
					// A broken link is not a file.
				}
				continue
			}
			if (info.isDirectory()) {
				if (!name.startsWith('.')) walk(full, rel)
			} else if (info.isFile()) {
				out.push({ path: rel, size: info.size })
			}
		}
	}
	walk(folder, '')
	return out.slice(0, limit)
}

interface Collected {
	readonly entry: SkillCatalogEntry
	/** Where the skill's folder is; absent for a plugin's skill, which has none the host opens. */
	readonly folder?: string
}

function collect(options: CatalogOptions): Collected[] {
	const now = options.now ?? Date.now()
	const roster = discoverSkillRoster({
		cwd: options.cwd,
		...(options.config ? { config: options.config } : {}),
		...(options.home ? { home: options.home } : {}),
		...(options.systemDir ? { systemDir: options.systemDir } : {}),
	})
	const usage = readSkillUsage(undefined, now)
	const useOf = (name: string) => {
		const use = usage.skills[name]
		if (!use) return {}
		return {
			uses: use.count,
			uses7d: use.loads.filter((load) => now - load.at < WEEK_MS).length,
			lastUsedAt: new Date(use.lastUsedAt).toISOString(),
		}
	}
	const collected: Collected[] = []
	for (const skill of roster.skills) {
		if (!options.includeProject && skill.source === 'project') continue
		const folder = dirname(skill.path)
		let updatedAt: string | undefined
		try {
			updatedAt = statSync(skill.path).mtime.toISOString()
		} catch {
			// A file that vanished since discovery has no time.
		}
		collected.push({
			folder,
			entry: {
				name: skill.name,
				description: skill.description.slice(0, DESCRIPTION_MAX),
				tier: skill.tier,
				place: skillTierLabel(skill.tier),
				state: skillStateOf(skill),
				...(updatedAt ? { updatedAt } : {}),
				fileCount: listSkillFolderFiles(folder).length,
				...useOf(skill.name),
				removable: REMOVABLE.has(skill.tier),
			},
		})
	}
	for (const plugin of options.plugins ?? []) {
		for (const skill of plugin.skills ?? []) {
			collected.push({
				entry: {
					name: skill.name,
					description: skill.description.slice(0, DESCRIPTION_MAX),
					tier: 'plugin',
					place: 'plugin',
					plugin: plugin.name,
					state: plugin.startupEnabled === false ? 'off' : 'on',
					...(plugin.updatedAt ? { updatedAt: plugin.updatedAt } : {}),
					fileCount: 0,
					...useOf(skill.name),
					removable: false,
				},
			})
		}
	}
	return collected
}

/** The skills the engine finds with what the Customize page shows of each; reads files, runs nothing. */
export function buildSkillCatalog(options: CatalogOptions): readonly SkillCatalogEntry[] {
	return collect(options).map((item) => item.entry)
}

function folderOf(name: string, options: CatalogOptions): string {
	const found = collect(options).find((item) => item.entry.name === name)
	if (!found) throw new Error('No skill by that name.')
	if (!found.folder) throw new Error('This skill has no folder of its own to read.')
	return found.folder
}

/** The files in one skill's folder. */
export function skillFiles(
	name: string,
	options: CatalogOptions,
): { path: string; size: number }[] {
	return listSkillFolderFiles(folderOf(name, options))
}

/** A path that stays a plain relative name inside a skill folder, as parts. */
function relativeParts(path: string): string[] {
	if (
		typeof path !== 'string' ||
		path.length === 0 ||
		path.length > 512 ||
		path.includes('\0') ||
		isAbsolute(path) ||
		/^([a-zA-Z]:|[\\/])/.test(path)
	)
		throw new Error('The path is a file inside the skill folder.')
	const parts = path.split(/[\\/]/).filter((part) => part !== '' && part !== '.')
	if (parts.length === 0 || parts.some((part) => part === '..'))
		throw new Error('The path is a file inside the skill folder.')
	if (parts.slice(0, -1).some((part) => part.startsWith('.')))
		throw new Error('The path is a file inside the skill folder.')
	return parts
}

/** One text file of a skill's folder, up to {@link MAX_FILE_BYTES}; a binary file is refused. */
export function readSkillFile(
	name: string,
	path: string,
	options: CatalogOptions,
): { text: string; truncated: boolean } {
	const parts = relativeParts(path)
	const folder = folderOf(name, options)
	const rootReal = realpathSync(folder)
	let real: string
	try {
		real = realpathSync(join(rootReal, ...parts))
	} catch {
		throw new Error('That file is not in the skill folder.')
	}
	if (!insideReal(rootReal, real) || real === rootReal)
		throw new Error('The path is a file inside the skill folder.')
	const info = statSync(real)
	if (!info.isFile()) throw new Error('That is not a file.')
	const fd = openSync(real, 'r')
	try {
		const buffer = Buffer.alloc(Math.min(info.size, MAX_FILE_BYTES))
		const read = readSync(fd, buffer, 0, buffer.length, 0)
		const bytes = buffer.subarray(0, read)
		if (bytes.includes(0)) throw new Error('This file is not text, so it is not shown.')
		return { text: bytes.toString('utf8'), truncated: info.size > MAX_FILE_BYTES }
	} finally {
		closeSync(fd)
	}
}
