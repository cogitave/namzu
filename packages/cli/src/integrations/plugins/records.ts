/**
 * The two install records under `<home>/plugins/`:
 *
 * - `known_marketplaces.json`: the marketplaces this computer has added.
 * - `installed_plugins.json` (version 2): one list of records per plugin id,
 *   one record per (scope, folder).
 *
 * Both are read and written through `json-state.ts`, so a damaged file holds
 * (it is kept, a recovery copy is named, nothing is replaced) and a key this
 * Namzu does not know stays as it was written. An entry that does not read as
 * a record is reported and left in the file; it never stops the others.
 *
 * Records are written by the install commands; nothing in this file fetches or
 * runs anything.
 */

import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { type JsonObjectRead, isRecord, readJsonObject, updateJsonObject } from './json-state.js'

export const INSTALLED_PLUGINS_VERSION = 2
export type RecordScope = 'user' | 'project' | 'local'
export const RECORD_SCOPES: readonly RecordScope[] = ['user', 'project', 'local']

/** `<plugin>@<marketplace>`: each half starts with a letter or digit. */
export const PLUGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export const MARKETPLACE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export const MARKETPLACE_SOURCE_KINDS = ['github', 'git', 'url', 'directory', 'file'] as const

export function isPluginId(value: unknown): boolean {
	return typeof value === 'string' && PLUGIN_ID_PATTERN.test(value)
}

/** The plugin's name and the marketplace it came from. */
export function splitPluginId(id: string): { readonly name: string; readonly marketplace: string } {
	const at = id.lastIndexOf('@')
	return { name: id.slice(0, at), marketplace: id.slice(at + 1) }
}

export function pluginsFolder(home: string): string {
	return join(home, 'plugins')
}
export function knownMarketplacesPath(home: string): string {
	return join(pluginsFolder(home), 'known_marketplaces.json')
}
/** Where marketplaces Namzu downloaded are kept, one folder per name. */
export function marketplacesFolder(home: string): string {
	return join(pluginsFolder(home), 'marketplaces')
}

export function installedPluginsPath(home: string): string {
	return join(pluginsFolder(home), 'installed_plugins.json')
}
export function installManifestsFolder(home: string): string {
	return join(pluginsFolder(home), '.install-manifests')
}
export function pluginCacheFolder(home: string): string {
	return join(pluginsFolder(home), 'cache')
}
/** `NAMZU_PLUGIN_DATA` of an installed plugin. */
export function installedPluginDataFolder(home: string, id: string): string {
	return join(pluginsFolder(home), 'data', id)
}

/** The folders under `plugins/` that hold Namzu's own state, never a hand-placed plugin. */
export const RESERVED_PLUGIN_FOLDERS: readonly string[] = ['cache', 'marketplaces', 'data']

/** Whether `dir` is one of Namzu's own state folders directly under the user's `plugins/`. */
export function isReservedPluginDir(home: string, dir: string): boolean {
	return dirname(dir) === pluginsFolder(home) && RESERVED_PLUGIN_FOLDERS.includes(basename(dir))
}

/** A path as the file system names it, so two spellings of one folder compare equal. */
export function realPathOrResolved(path: string): string {
	try {
		return realpathSync.native(path)
	} catch {
		return resolve(path)
	}
}

export function samePath(a: string, b: string): boolean {
	return realPathOrResolved(a) === realPathOrResolved(b)
}

export interface RecordFinding {
	readonly level: string
	readonly code: string
	readonly field?: string
	readonly message: string
}

export interface InstallRecord {
	readonly scope: RecordScope
	/** The folder the plugin runs from, under `plugins/cache/`. */
	readonly installPath: string
	/** The folder a `project` or `local` record is for. */
	readonly projectPath?: string
	readonly version?: string
	readonly installedAt?: string
	readonly lastUpdated?: string
	readonly gitCommitSha?: string
	readonly layout?: 'common' | 'namzu'
	readonly surfaceSha256?: string
	readonly findings: readonly RecordFinding[]
}

export interface InstalledProblem {
	readonly id: string
	readonly reason: string
}

export type InstalledRead =
	| {
			readonly state: 'missing'
			readonly plugins: ReadonlyMap<string, readonly InstallRecord[]>
			readonly invalid: readonly InstalledProblem[]
	  }
	| {
			readonly state: 'ok'
			readonly plugins: ReadonlyMap<string, readonly InstallRecord[]>
			readonly invalid: readonly InstalledProblem[]
	  }
	| { readonly state: 'unreadable'; readonly reason: string }

function installedShape(raw: Record<string, unknown>): string | undefined {
	if (raw.version !== INSTALLED_PLUGINS_VERSION)
		return raw.version === undefined
			? 'it names no version'
			: typeof raw.version === 'number' && raw.version > INSTALLED_PLUGINS_VERSION
				? `version ${raw.version} is newer than this Namzu`
				: `version ${String(raw.version)} is not one this Namzu reads`
	if (!isRecord(raw.plugins)) return 'its "plugins" entry is not a mapping'
	return undefined
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** One entry as a record, or why it is not one. */
export function parseInstallRecord(entry: unknown): InstallRecord | string {
	if (!isRecord(entry)) return 'the record is not a mapping'
	const scope = entry.scope
	if (scope !== 'user' && scope !== 'project' && scope !== 'local')
		return 'its scope is not user, project or local'
	const installPath = asString(entry.installPath)
	if (installPath === undefined || !isAbsolute(installPath))
		return 'its installPath is not an absolute path'
	let projectPath: string | undefined
	if (scope !== 'user') {
		projectPath = asString(entry.projectPath)
		if (projectPath === undefined || !isAbsolute(projectPath))
			return `a ${scope} record needs the absolute projectPath it is for`
	}
	const layout = entry.layout === 'common' || entry.layout === 'namzu' ? entry.layout : undefined
	const findings: RecordFinding[] = []
	if (Array.isArray(entry.findings)) {
		for (const item of entry.findings) {
			if (!isRecord(item)) continue
			const message = asString(item.message)
			const code = asString(item.code)
			const level = asString(item.level)
			if (message === undefined || code === undefined || level === undefined) continue
			findings.push({
				level,
				code,
				message,
				...(asString(item.field) ? { field: String(item.field) } : {}),
			})
		}
	}
	const version = asString(entry.version)
	const installedAt = asString(entry.installedAt)
	const lastUpdated = asString(entry.lastUpdated)
	const gitCommitSha = asString(entry.gitCommitSha)
	const surfaceSha256 = asString(entry.surfaceSha256)
	return {
		scope,
		installPath,
		...(projectPath !== undefined ? { projectPath } : {}),
		...(version !== undefined ? { version } : {}),
		...(installedAt !== undefined ? { installedAt } : {}),
		...(lastUpdated !== undefined ? { lastUpdated } : {}),
		...(gitCommitSha !== undefined ? { gitCommitSha } : {}),
		...(layout !== undefined ? { layout } : {}),
		...(surfaceSha256 !== undefined ? { surfaceSha256 } : {}),
		findings,
	}
}

function readInstalledRaw(home: string): JsonObjectRead {
	return readJsonObject(installedPluginsPath(home), installedShape)
}

export function readInstalledPlugins(home: string): InstalledRead {
	const read = readInstalledRaw(home)
	if (read.state === 'unreadable') return read
	const plugins = new Map<string, InstallRecord[]>()
	const invalid: InstalledProblem[] = []
	const mapping = read.state === 'ok' ? (read.raw.plugins as Record<string, unknown>) : {}
	for (const [id, list] of Object.entries(mapping)) {
		if (!isPluginId(id)) {
			invalid.push({ id, reason: 'it is not a plugin id (name@marketplace)' })
			continue
		}
		if (!Array.isArray(list)) {
			invalid.push({ id, reason: 'its records are not a list' })
			continue
		}
		const kept: InstallRecord[] = []
		for (const entry of list) {
			const parsed = parseInstallRecord(entry)
			if (typeof parsed === 'string') invalid.push({ id, reason: parsed })
			else kept.push(parsed)
		}
		if (kept.length > 0) plugins.set(id, kept)
	}
	return { state: read.state, plugins, invalid }
}

const INSTALLED_UPDATE = (home: string) => ({
	home,
	check: installedShape,
	empty: () => ({ version: INSTALLED_PLUGINS_VERSION, plugins: {} }),
	remedy: 'Fix or remove the file, then try again. The install record stays as it is until then.',
})

function sameRecordKey(
	entry: unknown,
	record: { scope: RecordScope; projectPath?: string },
): boolean {
	if (!isRecord(entry) || entry.scope !== record.scope) return false
	if (record.scope === 'user') return true
	return (
		typeof entry.projectPath === 'string' &&
		record.projectPath !== undefined &&
		samePath(entry.projectPath, record.projectPath)
	)
}

/** The mapping of one record as written; fields the caller does not name are kept when it replaces one. */
export type RecordFields = Record<string, unknown> & { scope: RecordScope; installPath: string }

/**
 * Add or replace the record for (scope, projectPath) under `id`. A replaced
 * record keeps any key this Namzu does not know. One id may hold at most one
 * record per scope and folder.
 */
export function putInstallRecord(home: string, id: string, fields: RecordFields): void {
	if (!isPluginId(id)) throw new Error(`"${id}" is not a plugin id (name@marketplace).`)
	const parsed = parseInstallRecord(fields)
	if (typeof parsed === 'string') throw new Error(`Not a valid install record: ${parsed}.`)
	updateJsonObject(installedPluginsPath(home), INSTALLED_UPDATE(home), (raw) => {
		const plugins = { ...(raw.plugins as Record<string, unknown>) }
		const list = Array.isArray(plugins[id]) ? [...(plugins[id] as unknown[])] : []
		const at = list.findIndex((entry) => sameRecordKey(entry, fields))
		if (at >= 0) list[at] = { ...(isRecord(list[at]) ? list[at] : {}), ...fields }
		else list.push(fields)
		plugins[id] = list
		raw.plugins = plugins
		raw.version = INSTALLED_PLUGINS_VERSION
		return true
	})
}

/** Remove the record for (scope, projectPath) under `id`; false when there was none. */
export function removeInstallRecord(
	home: string,
	id: string,
	which: { scope: RecordScope; projectPath?: string },
): boolean {
	return updateJsonObject(installedPluginsPath(home), INSTALLED_UPDATE(home), (raw) => {
		const plugins = { ...(raw.plugins as Record<string, unknown>) }
		const list = Array.isArray(plugins[id]) ? (plugins[id] as unknown[]) : []
		const kept = list.filter((entry) => !sameRecordKey(entry, which))
		if (kept.length === list.length) return false
		if (kept.length === 0) delete plugins[id]
		else plugins[id] = kept
		raw.plugins = plugins
		return true
	})
}

export interface KnownMarketplace {
	readonly name: string
	readonly source: Readonly<Record<string, unknown>> & { readonly source: string }
	readonly installLocation: string
	readonly lastUpdated?: string
	readonly autoUpdate?: boolean
	readonly commit?: string
}

export type KnownMarketplacesRead =
	| {
			readonly state: 'missing' | 'ok'
			readonly marketplaces: ReadonlyMap<string, KnownMarketplace>
			readonly invalid: readonly InstalledProblem[]
	  }
	| { readonly state: 'unreadable'; readonly reason: string }

/** A marketplace `source` mapping, or why it is not one. */
export function parseMarketplaceSource(value: unknown): KnownMarketplace['source'] | string {
	if (!isRecord(value)) return 'its source is not a mapping'
	const kind = value.source
	if (typeof kind !== 'string' || !(MARKETPLACE_SOURCE_KINDS as readonly string[]).includes(kind))
		return `its source kind is not one of ${MARKETPLACE_SOURCE_KINDS.join(', ')}`
	return value as KnownMarketplace['source']
}

export function readKnownMarketplaces(home: string): KnownMarketplacesRead {
	const read = readJsonObject(knownMarketplacesPath(home))
	if (read.state === 'unreadable') return read
	const marketplaces = new Map<string, KnownMarketplace>()
	const invalid: InstalledProblem[] = []
	for (const [name, entry] of Object.entries(read.state === 'ok' ? read.raw : {})) {
		if (!MARKETPLACE_NAME_PATTERN.test(name)) {
			invalid.push({ id: name, reason: 'it is not a marketplace name' })
			continue
		}
		if (!isRecord(entry)) {
			invalid.push({ id: name, reason: 'the entry is not a mapping' })
			continue
		}
		const source = parseMarketplaceSource(entry.source)
		const location = asString(entry.installLocation)
		if (typeof source === 'string' || location === undefined || !isAbsolute(location)) {
			invalid.push({
				id: name,
				reason: typeof source === 'string' ? source : 'its installLocation is not an absolute path',
			})
			continue
		}
		marketplaces.set(name, {
			name,
			source,
			installLocation: location,
			...(asString(entry.lastUpdated) ? { lastUpdated: String(entry.lastUpdated) } : {}),
			...(typeof entry.autoUpdate === 'boolean' ? { autoUpdate: entry.autoUpdate } : {}),
			...(asString(entry.commit) ? { commit: String(entry.commit) } : {}),
		})
	}
	return { state: read.state, marketplaces, invalid }
}

const KNOWN_UPDATE = (home: string) => ({
	home,
	remedy: 'Fix or remove the file, then try again. The marketplace list stays as it is until then.',
})

/** Add or replace one marketplace's entry; keys of an existing entry this Namzu does not know are kept. */
export function putKnownMarketplace(
	home: string,
	name: string,
	fields: Record<string, unknown> & { source: unknown; installLocation: string },
): void {
	if (!MARKETPLACE_NAME_PATTERN.test(name)) throw new Error(`"${name}" is not a marketplace name.`)
	const source = parseMarketplaceSource(fields.source)
	if (typeof source === 'string') throw new Error(`Not a valid marketplace: ${source}.`)
	updateJsonObject(knownMarketplacesPath(home), KNOWN_UPDATE(home), (raw) => {
		raw[name] = { ...(isRecord(raw[name]) ? raw[name] : {}), ...fields }
		return true
	})
}

export function removeKnownMarketplace(home: string, name: string): boolean {
	return updateJsonObject(knownMarketplacesPath(home), KNOWN_UPDATE(home), (raw) => {
		if (!(name in raw)) return false
		delete raw[name]
		return true
	})
}
