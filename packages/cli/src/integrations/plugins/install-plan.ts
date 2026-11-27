/**
 * Everything before a person says yes to an install: the plugin is copied into
 * a staging folder, read, and its consent surface computed. Nothing is written
 * outside `plugins/.staging/` here, and nothing from the plugin is run.
 *
 * Sources: a folder, an archive (the shared zip reader, with plugin limits),
 * or a catalog entry whose source is a folder inside a registered marketplace.
 * Every source is first copied into staging, links not followed and counts and
 * sizes bounded, so what is read, shown and hashed is the copy that would run.
 */

import { randomUUID } from 'node:crypto'
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import {
	type PluginManifest,
	discoverAllPluginDirs,
	findCommonLayoutRoot,
	loadPluginManifest,
	loadPluginManifestWithFindings,
	readCommonLayout,
} from '@namzu/sdk'

import { ArchiveError, type ArchiveLimits, openArchive } from '../archive/zip.js'
import { FetchError, type FetchOptions } from './fetch/git.js'
import { type FetchedPlugin, fetchPlugin } from './fetch/index.js'
import type { RemoteEntrySource } from './fetch/source.js'
import { listMarkdownNames, resolvePluginFileDirs } from './files.js'
import { surfaceDigest } from './install-manifest.js'
import { readPluginManifestDetails } from './manifest-details.js'
import { type CatalogEntry, ENTRY_SIDECAR_KEEPS, LOCAL_UPLOADS_MARKETPLACE } from './marketplace.js'
import {
	type InstallRecord,
	PLUGIN_ID_PATTERN,
	type RecordFinding,
	isReservedPluginDir,
	pluginsFolder,
	readInstalledPlugins,
	splitPluginId,
} from './records.js'
import {
	type PluginFiles,
	type PluginSurface,
	hashExecutableFiles,
	readSurface,
} from './surface.js'

/** A plugin copy is refused above these. The reader enforces the same numbers again. */
export const PLUGIN_COPY_MAX_FILES = 20_000
export const PLUGIN_COPY_MAX_BYTES = 256 * 1024 * 1024
export const PLUGIN_ARCHIVE_MAX_BYTES = 200 * 1024 * 1024

/** The plugin archive limits: the entry count, unpacked size and ratio the design names. */
export const PLUGIN_ARCHIVE_LIMITS: ArchiveLimits = {
	maxEntries: 5_000,
	maxUnpackedBytes: PLUGIN_COPY_MAX_BYTES,
	maxRatio: 100,
	allowExecutable: true,
	subject: 'plugin archive',
}

/** Why a plan could not be made. `code` is the exit status. */
export class PlanRefusal extends Error {
	override readonly name = 'PlanRefusal'
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message)
	}
}

export function stagingFolder(home: string): string {
	return join(pluginsFolder(home), '.staging')
}

const SKIPPED_NAMES = new Set(['.git', '__MACOSX', '.DS_Store'])
const REFUSED = 65

function within(outer: string, inner: string): boolean {
	const rel = relative(outer, inner)
	return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

interface Counter {
	files: number
	bytes: number
}

/**
 * Copy a folder into `dest`, skipping `.git` and archive junk, not following a
 * link and not copying a device or pipe. A link or special file is reported
 * as an ignored finding. Modes are normalised to 0644 or 0755. Throws a
 * {@link PlanRefusal} past the file or byte cap.
 */
export function copyPluginTree(src: string, dest: string, findings: RecordFinding[]): Counter {
	const counter: Counter = { files: 0, bytes: 0 }
	const walk = (from: string, to: string, prefix: string): void => {
		mkdirSync(to, { recursive: true, mode: 0o755 })
		for (const entry of readdirSync(from, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			if (SKIPPED_NAMES.has(entry.name)) continue
			const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
			const source = join(from, entry.name)
			const stat = lstatSync(source)
			if (stat.isSymbolicLink()) {
				findings.push({
					level: 'ignored',
					code: 'symlink',
					field: rel,
					message: `${rel} is a link and was not copied.`,
				})
			} else if (stat.isDirectory()) walk(source, join(to, entry.name), rel)
			else if (stat.isFile()) {
				counter.files += 1
				counter.bytes += stat.size
				if (counter.files > PLUGIN_COPY_MAX_FILES)
					throw new PlanRefusal(
						REFUSED,
						`The plugin has more than ${PLUGIN_COPY_MAX_FILES} files, which is more than Namzu installs.`,
					)
				if (counter.bytes > PLUGIN_COPY_MAX_BYTES)
					throw new PlanRefusal(
						REFUSED,
						`The plugin is larger than ${PLUGIN_COPY_MAX_BYTES / (1024 * 1024)} MiB, which is more than Namzu installs.`,
					)
				const target = join(to, entry.name)
				copyFileSync(source, target)
				chmodSync(target, (stat.mode & 0o100) !== 0 ? 0o755 : 0o644)
			} else
				findings.push({
					level: 'ignored',
					code: 'special-file',
					field: rel,
					message: `${rel} is not a regular file and was not copied.`,
				})
		}
	}
	walk(src, dest, '')
	return counter
}

/** Unpack a plugin archive into `dest` after the zip-safety checks. A refusal writes nothing. */
export function unpackPluginArchive(file: string, dest: string): void {
	let size: number
	try {
		size = statSync(file).size
	} catch {
		throw new PlanRefusal(66, `${file} could not be read.`)
	}
	if (size > PLUGIN_ARCHIVE_MAX_BYTES)
		throw new PlanRefusal(
			REFUSED,
			`The archive is larger than ${PLUGIN_ARCHIVE_MAX_BYTES / (1024 * 1024)} MiB.`,
		)
	let files: ReturnType<typeof openArchive>
	try {
		files = openArchive(readFileSync(file), PLUGIN_ARCHIVE_LIMITS)
	} catch (error) {
		if (error instanceof ArchiveError) throw new PlanRefusal(REFUSED, error.message)
		throw error
	}
	let count = 0
	for (const [name, entry] of files) {
		if (name.split('/').some((part) => SKIPPED_NAMES.has(part))) continue
		if (++count > PLUGIN_COPY_MAX_FILES)
			throw new PlanRefusal(REFUSED, `The archive has more than ${PLUGIN_COPY_MAX_FILES} files.`)
		const target = join(dest, ...name.split('/'))
		if (!within(dest, target)) throw new PlanRefusal(REFUSED, `${name} climbs out of the archive.`)
		mkdirSync(dirname(target), { recursive: true, mode: 0o755 })
		writeFileSync(target, entry.bytes, { mode: entry.executable ? 0o755 : 0o644 })
		chmodSync(target, entry.executable ? 0o755 : 0o644)
	}
}

/** Remove a staging folder; a failure is not an error, the next explicit `prune` takes it. */
export function discardStaging(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true })
	} catch {
		// Left for `namzu plugin prune`.
	}
}

export type InstallSource =
	| {
			readonly kind: 'catalog'
			readonly marketplace: string
			readonly entry: CatalogEntry
			readonly dir: string
			readonly version?: string
			/** The commit of the marketplace repository the folder was read from. */
			readonly commit?: string
	  }
	| {
			/** An entry whose plugin is downloaded: a repository, a folder of one, or a zip. */
			readonly kind: 'remote-catalog'
			readonly marketplace: string
			readonly entry: CatalogEntry
			readonly remote: RemoteEntrySource
	  }
	| { readonly kind: 'path'; readonly path: string }

export interface InstallPlan {
	readonly id: string
	readonly name: string
	readonly marketplace: string
	readonly version: string
	/** The commit a repository source was at, in full. */
	readonly commit?: string
	readonly layout: 'common' | 'namzu'
	/** `plugins/.staging/<uuid>`: removed when the plan is discarded or committed. */
	readonly stagingDir: string
	/** The folder that becomes `cache/<marketplace>/<name>/<version>`. */
	readonly root: string
	readonly manifest: PluginManifest
	readonly findings: readonly RecordFinding[]
	/** Entry-level refusals the reader and the hook readers named; the plugin installs without these parts. */
	readonly surface: PluginSurface
	readonly executable: readonly string[]
	readonly files: Readonly<Record<string, string>>
	readonly digest: string
	readonly inventory: {
		readonly skills: readonly string[]
		readonly commands: readonly string[]
		readonly agents: readonly string[]
	}
	readonly installedFrom: Readonly<Record<string, unknown>>
	/** Sentences a person should read before agreeing (a clash is a refusal, not here). */
	readonly warnings: readonly string[]
}

export interface PlanOptions {
	readonly home: string
	readonly cwd: string
	/** How downloads are made; tests replace parts of it. */
	readonly fetch?: FetchOptions
}

const DATA_SENTINEL = '/namzu-sentinel/plugin-data'
const PROJECT_SENTINEL = '/namzu-sentinel/project'
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/

/** The names already taken here: installed plugins by id, hand-placed ones by name. */
export async function usedPluginNames(options: PlanOptions): Promise<Map<string, string>> {
	const used = new Map<string, string>()
	const read = readInstalledPlugins(options.home)
	if (read.state !== 'unreadable')
		for (const id of read.plugins.keys()) used.set(splitPluginId(id).name, id)
	try {
		const discovered = await discoverAllPluginDirs(options.cwd, {
			enabled: true,
			autoDiscovery: true,
			allowedScopes: ['project', 'user'],
			userRoot: options.home,
		})
		for (const scope of ['project', 'user'] as const)
			for (const dir of discovered[scope]) {
				if (scope === 'user' && isReservedPluginDir(options.home, dir)) continue
				try {
					const name = (await loadPluginManifest(dir, { skillsSupported: true })).name
					if (!used.has(name)) used.set(name, `the plugin folder ${dir}`)
				} catch {
					// A folder that does not read holds no name.
				}
			}
	} catch {
		// Discovery failing leaves only the installed plugins to compare.
	}
	return used
}

/** The sentence for a name that is taken, or `undefined`. A plugin may share its own id's name. */
export async function nameClash(
	options: PlanOptions,
	name: string,
	id: string,
): Promise<string | undefined> {
	const holder = (await usedPluginNames(options)).get(name)
	if (holder === undefined || holder === id) return undefined
	return `The name "${name}" is already used by ${holder}. Remove it first, or ask the author to rename this plugin.`
}

function sidecarFor(entry: CatalogEntry): string | undefined {
	if (entry.strict) return undefined
	const kept: Record<string, unknown> = {}
	for (const key of ENTRY_SIDECAR_KEEPS) if (key in entry.raw) kept[key] = entry.raw[key]
	return `${JSON.stringify(kept, null, 2)}\n`
}

const SIDECAR_FILE = '.namzu-entry.json'

/**
 * Stage a source and read it: the copy, the reader, the surface and its
 * digest. Throws {@link PlanRefusal} (and removes the staging folder) when the
 * plugin cannot be installed at all. The caller discards the plan, or commits it.
 */
export async function planInstall(
	source: InstallSource,
	options: PlanOptions,
): Promise<InstallPlan> {
	const staging = join(stagingFolder(options.home), randomUUID())
	mkdirSync(staging, { recursive: true, mode: 0o700 })
	try {
		return await build(source, options, staging)
	} catch (error) {
		discardStaging(staging)
		throw error
	}
}

async function build(
	source: InstallSource,
	options: PlanOptions,
	staging: string,
): Promise<InstallPlan> {
	const findings: RecordFinding[] = []
	const root = join(staging, 'plugin')
	let installedFrom: Record<string, unknown>
	let marketplace: string
	let entry: CatalogEntry | undefined
	let commit: string | undefined
	let unpinnedDownload = false
	const notes: string[] = []

	if (source.kind === 'remote-catalog') {
		marketplace = source.marketplace
		entry = source.entry
		installedFrom = { marketplace, source: entry.source, kind: 'catalog' }
		let fetched: FetchedPlugin
		try {
			fetched = await fetchPlugin(source.remote, staging, options.fetch)
		} catch (error) {
			if (error instanceof FetchError) throw new PlanRefusal(error.code, error.message)
			throw error
		}
		commit = fetched.commit
		if (fetched.lfsPointers > 0)
			notes.push(
				`${fetched.lfsPointers} ${fetched.lfsPointers === 1 ? 'file is' : 'files are'} stored with Git LFS and was not downloaded; ${fetched.lfsPointers === 1 ? 'it stays' : 'they stay'} a small pointer file.`,
			)
		if (fetched.submodules > 0)
			notes.push(
				`The repository lists ${fetched.submodules} ${fetched.submodules === 1 ? 'submodule' : 'submodules'}; none was downloaded.`,
			)
		if (fetched.archive !== undefined) {
			if (source.remote.kind === 'archive' && source.remote.sha256 === undefined)
				unpinnedDownload = true
			const unpacked = join(staging, 'unpacked')
			mkdirSync(unpacked, { recursive: true, mode: 0o755 })
			unpackPluginArchive(fetched.archive.file, unpacked)
			const inner = await findCommonLayoutRoot(unpacked)
			renameSync(inner, root)
		} else if (fetched.dir !== undefined) copyFolderSource(fetched.dir, root, options, findings)
	} else if (source.kind === 'catalog') {
		marketplace = source.marketplace
		entry = source.entry
		installedFrom = {
			marketplace,
			source: entry.source,
			kind: 'catalog',
		}
		commit = source.commit
		copyFolderSource(source.dir, root, options, findings)
	} else {
		marketplace = LOCAL_UPLOADS_MARKETPLACE
		let stat: ReturnType<typeof lstatSync>
		try {
			stat = lstatSync(source.path)
		} catch {
			throw new PlanRefusal(66, `${source.path} was not found.`)
		}
		if (stat.isDirectory()) {
			installedFrom = { marketplace, source: realpathSync.native(source.path), kind: 'folder' }
			copyFolderSource(source.path, root, options, findings)
		} else if (stat.isFile()) {
			installedFrom = { marketplace, source: resolve(source.path), kind: 'archive' }
			const unpacked = join(staging, 'unpacked')
			mkdirSync(unpacked, { recursive: true, mode: 0o755 })
			unpackPluginArchive(source.path, unpacked)
			const inner = await findCommonLayoutRoot(unpacked)
			renameSync(inner, root)
		} else throw new PlanRefusal(66, `${source.path} is neither a folder nor an archive.`)
	}

	// A sidecar is Namzu's own write, from a marketplace entry: one that arrived with the files is dropped.
	const sidecarPath = join(root, SIDECAR_FILE)
	if (existsSync(sidecarPath)) {
		rmSync(sidecarPath, { force: true })
		findings.push({
			level: 'ignored',
			code: 'sidecar-shipped',
			field: SIDECAR_FILE,
			message: `${SIDECAR_FILE} came with the files and was removed; Namzu writes it itself.`,
		})
	}
	const sidecar = entry !== undefined ? sidecarFor(entry) : undefined
	if (sidecar !== undefined) writeFileSync(sidecarPath, sidecar, { mode: 0o644 })

	const installed = readInstalledPlugins(options.home)
	const installedIds = new Set<string>()
	if (installed.state !== 'unreadable')
		for (const id of installed.plugins.keys()) {
			installedIds.add(id)
			installedIds.add(splitPluginId(id).name)
		}
	const layoutOptions = {
		entrySidecar: true,
		// Every `${NAME}` a server's environment or headers refer to reads as itself, so a server
		// that needs a variable that is unset here is still read and listed, not dropped from what is shown.
		environment: new Proxy<Record<string, string | undefined>>(
			{},
			{ get: (_, name) => (typeof name === 'string' ? `\${${name}}` : undefined) },
		),
		installedIds,
		paths: () => ({ project: PROJECT_SENTINEL, data: DATA_SENTINEL }),
		...(entry?.version !== undefined ? { version: entry.version } : {}),
	}
	const layout = await readCommonLayout(root, layoutOptions)
	if (layout.refusal !== undefined) throw new PlanRefusal(REFUSED, layout.refusal.message)
	let manifest: PluginManifest
	try {
		manifest = (
			await loadPluginManifestWithFindings(root, {
				skillsSupported: true,
				commonLayout: layoutOptions,
			})
		).manifest
	} catch (error) {
		throw new PlanRefusal(REFUSED, error instanceof Error ? error.message : String(error))
	}
	const layoutKind: 'common' | 'namzu' = layout.source === 'namzu' ? 'namzu' : 'common'
	for (const finding of layout.findings) {
		if (finding.level === 'used') continue
		findings.push({
			level: finding.level,
			code: finding.code,
			field: finding.path ?? finding.field,
			message: finding.message,
		})
	}

	const name = manifest.name
	if (entry !== undefined && entry.name !== name)
		throw new PlanRefusal(
			REFUSED,
			`The catalog calls this plugin "${entry.name}" but the plugin calls itself "${name}". Ask the marketplace's owner to fix the entry.`,
		)
	const id = `${name}@${marketplace}`
	if (!PLUGIN_ID_PATTERN.test(id))
		throw new PlanRefusal(REFUSED, `"${id}" cannot be a plugin id (name@marketplace).`)
	const version = manifest.version
	if (!VERSION_PATTERN.test(version))
		throw new PlanRefusal(
			REFUSED,
			`The version "${version}" has characters that cannot be in a folder name.`,
		)
	const clash = await nameClash(options, name, id)
	if (clash !== undefined) throw new PlanRefusal(REFUSED, clash)

	const hashed: PluginFiles = hashExecutableFiles(root)
	const read = readSurface({
		root,
		manifest,
		remoteServers:
			layoutKind === 'namzu' ? (manifest.remoteMcpServers ?? []) : layout.remoteServers,
		setupServers: layout.findings.flatMap((finding) =>
			finding.code === 'mcp-needs-setup' && finding.server !== undefined ? [finding.server] : [],
		),
		scripts: hashed.scripts,
		unexpander: { root, dataSentinel: DATA_SENTINEL, projectSentinel: PROJECT_SENTINEL },
	})
	for (const problem of read.problems)
		findings.push({
			level: 'refused',
			code: problem.code,
			field: problem.file,
			message: problem.message,
		})

	// What it brings, by the names it is used under.
	const details = await readPluginManifestDetails(root, manifest)
	const named = (declared: readonly string[] | undefined): string[] =>
		resolvePluginFileDirs(name, root, declared, manifest.layout).dirs.flatMap((dir) =>
			listMarkdownNames(dir.dir, dir.only).map((file) => `${name}__${file}`),
		)
	const warnings: string[] = [...notes]
	if (manifest.remoteMcpServers !== undefined || layout.remoteServers.length > 0)
		warnings.push('Remote servers ask you before they connect; nothing connects at install.')
	const surface: PluginSurface = unpinnedDownload
		? { ...read.surface, unpinnedDownload: true }
		: read.surface
	const digest = surfaceDigest(surface, hashed.files, hashed.executable)
	return {
		id,
		name,
		marketplace,
		version,
		...(commit !== undefined ? { commit } : {}),
		layout: layoutKind,
		stagingDir: staging,
		root,
		manifest,
		findings,
		surface,
		executable: hashed.executable,
		files: hashed.files,
		digest,
		inventory: {
			skills: (details.skills ?? []).map((skill) => skill.name),
			commands: named(manifest.commands),
			agents: named(manifest.agents),
		},
		installedFrom,
		warnings,
	}
}

function copyFolderSource(
	dir: string,
	root: string,
	options: PlanOptions,
	findings: RecordFinding[],
): void {
	let real: string
	try {
		real = realpathSync.native(dir)
	} catch {
		throw new PlanRefusal(66, `${dir} was not found.`)
	}
	if (!lstatSync(real).isDirectory()) throw new PlanRefusal(66, `${dir} is not a folder.`)
	// A folder that holds Namzu's own state would be copied into itself.
	if (within(real, pluginsFolder(options.home)) || within(real, options.home))
		throw new PlanRefusal(
			REFUSED,
			`${dir} holds Namzu's own folder, so it cannot be installed from. Pick the plugin's folder.`,
		)
	copyPluginTree(real, root, findings)
}

/** The record fields an install writes, from a plan. */
export function recordFields(
	plan: InstallPlan,
	where: { scope: InstallRecord['scope']; projectPath?: string; installPath: string; now: string },
): Record<string, unknown> & { scope: InstallRecord['scope']; installPath: string } {
	return {
		scope: where.scope,
		installPath: where.installPath,
		...(where.projectPath !== undefined ? { projectPath: where.projectPath } : {}),
		version: plan.version,
		...(plan.commit !== undefined ? { gitCommitSha: plan.commit } : {}),
		installedAt: where.now,
		lastUpdated: where.now,
		layout: plan.layout,
		surfaceSha256: plan.digest,
		findings: plan.findings.filter((f) => f.level !== 'used'),
	}
}
