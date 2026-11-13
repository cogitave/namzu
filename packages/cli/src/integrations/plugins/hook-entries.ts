/**
 * Hook entries a plugin ships.
 *
 * A plugin's manifest key `hooks` lists JavaScript modules. A path in it that
 * ends in `.json` is instead a file of entries (a command, an http address or a
 * prompt), read by the same reader a config file's `hooks` key goes through, in
 * either shape. The conventional file `hooks/hooks.json` in the plugin folder is
 * read when it exists, and the manifest key `hookEntries` holds the same events
 * object written inline. A file is the events object itself or an object with a
 * `hooks` key holding it.
 *
 * Nothing is dropped in silence. A file that cannot be read, a path that leaves
 * the plugin folder and an entry that cannot be loaded are returned as
 * problems (the entry on a guarding event is a `problem`, anything else a
 * `note`), and one bad event never keeps the others from loading.
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

import {
	type PluginManifest,
	discoverAllPluginDirs,
	isHookEntriesPath,
	loadPluginManifest,
} from '@namzu/sdk'

import { hookIdentity } from '../../config/hook-layers.js'
import { ConfigValueError, readPluginHookEntries } from '../../config/load.js'
import type { HookEntry, HooksConfig, PluginScope } from '../../config/schema.js'

/** The file a plugin moved from elsewhere keeps its entries in. */
export const CONVENTIONAL_HOOKS_FILE = 'hooks/hooks.json'

/** A hooks file larger than this is refused; no real one is. */
const MAX_HOOKS_FILE_BYTES = 1024 * 1024

export interface PluginHookProblem {
	/** `problem`: a hook that would have guarded something was lost. `note`: anything else. */
	readonly severity: 'problem' | 'note'
	/** A stable short name for the kind of problem, for `namzu plugin validate`. */
	readonly code:
		| 'hook-entries-outside'
		| 'hook-entries-missing'
		| 'hook-entries-unreadable'
		| 'hook-entries-json'
		| 'hook-entries-shape'
		| 'hook-entries-invalid'
		| 'hook-entries-note'
	/** Where it was read from, as the plugin names it: `hooks/hooks.json`, `plugin.json hookEntries`. */
	readonly file: string
	readonly message: string
}

export interface PluginHookEntries {
	/** The entries, each with `source` set to `plugin <name>`, in the order they were read. */
	readonly hooks: HooksConfig
	/** How many entries there are. */
	readonly count: number
	readonly problems: readonly PluginHookProblem[]
	/** The files and keys the entries came from. */
	readonly files: readonly string[]
}

/** The label an entry a plugin ships carries as its `source`. */
export function pluginHookSource(name: string): string {
	return `plugin ${name}`
}

/**
 * The folder kept for a plugin's data: under the Namzu home, never inside the
 * plugin's own folder. A user plugin is keyed by its name; a project plugin by
 * its name and its folder, so a repository cannot reach the data of a plugin
 * of the same name the person installed.
 */
export function pluginDataDir(
	home: string,
	plugin: { readonly name: string; readonly scope: PluginScope; readonly rootDir: string },
): string {
	const base = join(home, 'plugin-data')
	if (plugin.scope === 'project') {
		const key = createHash('sha256').update(plugin.rootDir).digest('hex').slice(0, 12)
		return join(base, 'project', `${plugin.name}-${key}`)
	}
	return join(base, 'user', plugin.name)
}

/** Whether `inner` is `outer` or inside it. */
function within(outer: string, inner: string): boolean {
	const path = relative(outer, inner)
	return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

/** Whether the data folder would sit inside the plugin's folder (or the other way round). */
export function dataDirOverlapsPlugin(dataDir: string, rootDir: string): boolean {
	return within(rootDir, dataDir) || within(dataDir, rootDir)
}

function isMapping(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

interface Collector {
	readonly problems: PluginHookProblem[]
	readonly seen: Set<string>
	readonly merged: Record<string, HookEntry[]>
	count: number
	readonly name: string
}

function add(collector: Collector, parsed: HooksConfig): void {
	for (const [event, entries] of Object.entries(parsed)) {
		for (const entry of entries ?? []) {
			// An entry the plugin lists twice (in its hooks file and in its manifest, or
			// twice in one) runs once; two plugins shipping the same text are two sources.
			const identity = hookIdentity(event, entry)
			if (collector.seen.has(identity)) continue
			collector.seen.add(identity)
			const list = collector.merged[event] ?? []
			list.push({ ...entry, source: pluginHookSource(collector.name) } as HookEntry)
			collector.merged[event] = list
			collector.count += 1
		}
	}
}

/**
 * The events object inside what a file or the manifest holds: the value itself,
 * or the mapping under its `hooks` key. Other keys beside `hooks` are said and
 * not acted on, except `description`, which a wrapper may carry.
 */
function unwrap(value: unknown, file: string, collector: Collector): unknown {
	if (isMapping(value) && isMapping(value.hooks)) {
		for (const key of Object.keys(value)) {
			if (key !== 'hooks' && key !== 'description') {
				collector.problems.push({
					severity: 'note',
					code: 'hook-entries-note',
					file,
					message: `"${key}" is not read beside "hooks" and is not acted on.`,
				})
			}
		}
		return value.hooks
	}
	return value
}

function readEvents(value: unknown, file: string, path: string, collector: Collector): void {
	const events = unwrap(value, file, collector)
	// `report` says a refusal; the whole-file attempt stays quiet, because when it
	// fails every event is read again on its own and says its own.
	const attempt = (input: unknown, report: boolean): boolean => {
		const found: PluginHookProblem[] = []
		try {
			const read = readPluginHookEntries(input, { file, path }, (_file, event, severity, message) =>
				found.push({
					severity,
					code: severity === 'problem' ? 'hook-entries-invalid' : 'hook-entries-note',
					file,
					message: `${event}: ${message}`,
				}),
			)
			collector.problems.push(...found)
			add(collector, read)
			return true
		} catch (error) {
			if (!(error instanceof ConfigValueError)) throw error
			if (report) {
				collector.problems.push({
					severity: 'problem',
					code: 'hook-entries-invalid',
					file,
					message: `${error.message.replace(/^config file [^:]*: /, '')}; its hooks are not loaded.`,
				})
			}
			return false
		}
	}
	if (!isMapping(events)) {
		collector.problems.push({
			severity: 'problem',
			code: 'hook-entries-shape',
			file,
			message:
				'must be an object of event names, each holding a list of hooks; none of it is loaded.',
		})
		return
	}
	if (attempt(events, false)) return
	// One event the reader refuses whole must not take the others with it: read
	// each on its own, so what can load does, and what cannot is said.
	for (const [event, entries] of Object.entries(events)) attempt({ [event]: entries }, true)
}

/** The path a manifest names, relative to the plugin, or why it is refused. */
function manifestPathProblem(path: string): string | undefined {
	if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.startsWith('\\')) {
		return 'is an absolute path; a plugin may only name files inside its own folder'
	}
	if (path.split(/[\\/]/).some((part) => part === '..')) {
		return 'leaves the plugin folder with "..", and is not read'
	}
	return undefined
}

function readFileEntries(
	rootDir: string,
	realRoot: string,
	rel: string,
	listed: boolean,
	collector: Collector,
): void {
	const refused = manifestPathProblem(rel)
	if (refused !== undefined) {
		collector.problems.push({
			severity: 'problem',
			code: 'hook-entries-outside',
			file: rel,
			message: `${rel} ${refused}.`,
		})
		return
	}
	const path = resolve(rootDir, rel)
	let real: string
	try {
		real = realpathSync(path)
	} catch {
		if (listed) {
			collector.problems.push({
				severity: 'problem',
				code: 'hook-entries-missing',
				file: rel,
				message: `${rel} is listed in the manifest's "hooks" and does not exist; its hooks are not loaded.`,
			})
		}
		return
	}
	if (!within(realRoot, real)) {
		collector.problems.push({
			severity: 'problem',
			code: 'hook-entries-outside',
			file: rel,
			message: `${rel} leaves the plugin folder (through a link) and is not read.`,
		})
		return
	}
	let size: number
	try {
		const info = lstatSync(real)
		if (!info.isFile()) {
			collector.problems.push({
				severity: 'problem',
				code: 'hook-entries-unreadable',
				file: rel,
				message: `${rel} is not a regular file; its hooks are not loaded.`,
			})
			return
		}
		size = info.size
	} catch (error) {
		collector.problems.push({
			severity: 'problem',
			code: 'hook-entries-unreadable',
			file: rel,
			message: `${rel} cannot be read (${error instanceof Error ? error.message : String(error)}); its hooks are not loaded.`,
		})
		return
	}
	if (size > MAX_HOOKS_FILE_BYTES) {
		collector.problems.push({
			severity: 'problem',
			code: 'hook-entries-unreadable',
			file: rel,
			message: `${rel} is larger than ${MAX_HOOKS_FILE_BYTES / 1024} KiB; its hooks are not loaded.`,
		})
		return
	}
	let value: unknown
	try {
		value = JSON.parse(readFileSync(real, 'utf8'))
	} catch (error) {
		collector.problems.push({
			severity: 'problem',
			code: 'hook-entries-json',
			file: rel,
			message: `${rel} is not valid JSON (${error instanceof Error ? error.message : String(error)}); its hooks are not loaded.`,
		})
		return
	}
	readEvents(value, rel, path, collector)
}

/**
 * Read every hook entry a plugin ships: the conventional file, the `.json`
 * paths of its manifest's `hooks`, and its inline `hookEntries`, in that order.
 */
export function readPluginHookEntriesOf(plugin: {
	readonly rootDir: string
	readonly manifest: PluginManifest
}): PluginHookEntries {
	const collector: Collector = {
		problems: [],
		seen: new Set(),
		merged: {},
		count: 0,
		name: plugin.manifest.name,
	}
	const files: string[] = []
	let realRoot: string
	try {
		realRoot = realpathSync(plugin.rootDir)
	} catch {
		realRoot = plugin.rootDir
	}
	const done = new Set<string>()
	const readFile = (rel: string, listed: boolean): void => {
		const key = rel.replace(/\\/g, '/').replace(/^\.\//, '')
		if (done.has(key)) return
		done.add(key)
		if (!listed && !existsSync(join(plugin.rootDir, rel))) return
		files.push(key)
		readFileEntries(plugin.rootDir, realRoot, rel, listed, collector)
	}
	readFile(CONVENTIONAL_HOOKS_FILE, false)
	for (const path of plugin.manifest.hooks ?? []) {
		if (isHookEntriesPath(path)) readFile(path, true)
	}
	if (plugin.manifest.hookEntries !== undefined) {
		files.push('plugin.json hookEntries')
		readEvents(
			plugin.manifest.hookEntries,
			'plugin.json hookEntries',
			join(plugin.rootDir, 'plugin.json'),
			collector,
		)
	}
	return {
		hooks: collector.merged as HooksConfig,
		count: collector.count,
		problems: collector.problems,
		files,
	}
}

/** `describeHooks`-style line for one entry: what it runs or reaches. */
export function describeEntryRuns(entry: HookEntry): string {
	if (entry.type === 'http') return `POST ${entry.url}`
	if (entry.type === 'prompt') return `ask: ${entry.prompt.replace(/\s+/g, ' ').slice(0, 60)}`
	return [entry.command, ...(entry.args ?? [])].join(' ')
}

/** What the plugins on disk ship, for the doctor row: read without starting a session. */
export interface PluginHookSummary {
	readonly plugins: readonly {
		readonly name: string
		readonly count: number
		/** The plugin is on at startup (its saved state; on unless switched off). */
		readonly enabled: boolean
		readonly problems: readonly PluginHookProblem[]
	}[]
	/** Project plugins that exist and were not read, because the folder is not trusted. */
	readonly unreadProjectPlugins: number
}

/**
 * The hook entries the plugins found in the folders a session would read ship,
 * and their problems. A project plugin is read only when `trusted`. `enabled`
 * says whether the plugin is on at startup.
 */
export async function summarizePluginHooks(options: {
	readonly cwd: string
	readonly home: string
	readonly allowedScopes: readonly PluginScope[]
	readonly autoDiscovery: boolean
	readonly trusted: boolean
	readonly enabled: (plugin: { readonly rootDir: string; readonly name: string }) => boolean
}): Promise<PluginHookSummary> {
	const scopes = options.allowedScopes.filter((scope) => scope !== 'project' || options.trusted)
	const dirs = await discoverAllPluginDirs(options.cwd, {
		enabled: true,
		autoDiscovery: options.autoDiscovery,
		allowedScopes: scopes,
		userRoot: options.home,
	})
	const plugins: PluginHookSummary['plugins'][number][] = []
	let unreadProjectPlugins = 0
	if (!options.trusted && options.allowedScopes.includes('project')) {
		const found = await discoverAllPluginDirs(options.cwd, {
			enabled: true,
			autoDiscovery: options.autoDiscovery,
			allowedScopes: ['project'],
			userRoot: options.home,
		})
		unreadProjectPlugins = found.project.length
	}
	for (const dir of [...dirs.project, ...dirs.user].sort((a, b) => a.localeCompare(b))) {
		try {
			const manifest = await loadPluginManifest(dir)
			const read = readPluginHookEntriesOf({ rootDir: dir, manifest })
			let enabled = true
			try {
				enabled = options.enabled({ rootDir: realpathSync(dir), name: manifest.name })
			} catch {
				enabled = false
			}
			if (read.count > 0 || read.problems.length > 0) {
				plugins.push({ name: manifest.name, count: read.count, enabled, problems: read.problems })
			}
		} catch {
			// A plugin whose manifest cannot be read is `namzu plugin validate`'s to say.
		}
	}
	return { plugins, unreadProjectPlugins }
}
