/**
 * The writes of installing, updating and removing a plugin, and of pruning what
 * they leave behind. Everything that changes the install records runs under the
 * lock of `installed_plugins.json`, so two Namzu processes never interleave.
 *
 * Crash safety is the order of the writes. An install moves the staged folder
 * into `cache/`, then writes the install manifest, then the record, then the
 * recorded yes. A crash anywhere in that leaves at worst a folder or a manifest
 * no record names, which `namzu plugin prune` removes; a record never points at
 * a folder that is not there. A removal runs the other way round: the record
 * goes first, the folder last.
 */

import { randomUUID } from 'node:crypto'
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	rmdirSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import { unreadableStateFile, withStateFileLock } from '../state/state-file.js'
import {
	type RecordLayer,
	readRecordLayer,
	recordLayerPath,
	setEnabledPlugin,
} from './enabled-records.js'
import {
	INSTALL_MANIFEST_VERSION,
	installManifestPath,
	isInsidePluginCache,
	readInstallManifest,
} from './install-manifest.js'
import { type InstallPlan, recordFields, stagingFolder } from './install-plan.js'
import {
	type InstallRecord,
	type RecordScope,
	installManifestsFolder,
	installedPluginDataFolder,
	installedPluginsPath,
	pluginCacheFolder,
	putInstallRecord,
	readInstalledPlugins,
	realPathOrResolved,
	removeInstallRecord,
	samePath,
} from './records.js'

/** The steps an install passes, for a test that makes one of them fail. */
export type InstallStep =
	| 'before-move'
	| 'after-move'
	| 'after-manifest'
	| 'after-record'
	| 'after-enabled'

/** Throw this from a fault hook to stand for the process dying: nothing is cleaned up. */
export class SimulatedCrash extends Error {
	override readonly name = 'SimulatedCrash'
}

/** A refusal with a sentence a person can act on, and the exit status it maps to. */
export class InstallConflict extends Error {
	override readonly name = 'InstallConflict'
	constructor(
		message: string,
		readonly code = 65,
	) {
		super(message)
	}
}

export interface WriteOptions {
	readonly home: string
	readonly now: Date
	readonly faults?: (step: InstallStep) => void
}

function readRecords(home: string): ReadonlyMap<string, readonly InstallRecord[]> {
	const read = readInstalledPlugins(home)
	if (read.state === 'unreadable')
		throw unreadableStateFile(
			installedPluginsPath(home),
			read.reason,
			home,
			'Fix or remove the file, then try again. The install record stays as it is until then.',
		)
	return read.plugins
}

function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
	const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
	renameSync(tmp, path)
}

/** Move a folder out of the way and delete it; a failure to delete leaves it for `prune`. */
export function trashFolder(home: string, path: string): void {
	const bin = join(stagingFolder(home), `trash-${Date.now()}-${randomUUID().slice(0, 8)}`)
	try {
		mkdirSync(dirname(bin), { recursive: true, mode: 0o700 })
		renameSync(path, bin)
		rmSync(bin, { recursive: true, force: true })
	} catch {
		try {
			rmSync(path, { recursive: true, force: true })
		} catch {
			// Left for `namzu plugin prune`.
		}
	}
}

export function cacheFolderOf(
	home: string,
	plan: { marketplace: string; name: string; version: string },
): string {
	return join(pluginCacheFolder(home), plan.marketplace, plan.name, plan.version)
}

/** The layer a scope's recorded yes lives in. */
function layerOf(scope: RecordScope): RecordLayer {
	return scope
}

export interface InstallWhere extends WriteOptions {
	readonly scope: RecordScope
	/** The folder a project or local install is for (a real path). */
	readonly cwd: string
	readonly consent: { readonly by: string; readonly nonInteractive: boolean }
}

export type InstallOutcome =
	| { readonly outcome: 'installed'; readonly installPath: string }
	| { readonly outcome: 'already-installed'; readonly installPath: string }

function manifestFile(plan: InstallPlan, where: InstallWhere): Record<string, unknown> {
	return {
		version: INSTALL_MANIFEST_VERSION,
		id: plan.id,
		installedFrom: plan.installedFrom,
		executable: plan.executable,
		files: plan.files,
		surface: plan.surface,
		surfaceSha256: plan.digest,
		consent: {
			at: where.now.toISOString(),
			scope: where.scope,
			by: where.consent.by,
			nonInteractive: where.consent.nonInteractive,
		},
	}
}

const SAME_VERSION_OTHER_CONTENTS =
	'This version already exists with other contents; nothing was changed.'

/**
 * Install a staged plan for one scope. The staging folder is removed when it
 * is no longer needed (installed, shared with another scope's copy, or failed
 * in a way that is cleaned up).
 */
export function commitInstall(plan: InstallPlan, where: InstallWhere): InstallOutcome {
	const { home } = where
	const dest = cacheFolderOf(home, plan)
	const projectPath = where.scope === 'user' ? undefined : where.cwd
	return withStateFileLock(installedPluginsPath(home), () => {
		const existing = readRecords(home).get(plan.id) ?? []
		const sameScope = existing.find(
			(record) =>
				record.scope === where.scope &&
				(projectPath === undefined ||
					(record.projectPath !== undefined && samePath(record.projectPath, projectPath))),
		)
		const otherVersion = existing.find((record) => record.version !== plan.version)
		if (otherVersion !== undefined)
			throw new InstallConflict(
				`${plan.id} ${otherVersion.version ?? ''} is already installed (scope: ${otherVersion.scope}). Its scopes share one copy; to change its version run: namzu plugin update ${plan.id}`.replace(
					/\s+/g,
					' ',
				),
			)
		const recorded = readInstallManifest(home, plan.id)
		const sameContents = recorded.state === 'ok' && recorded.manifest.surfaceSha256 === plan.digest
		if (existing.length > 0) {
			if (!sameContents) throw new InstallConflict(SAME_VERSION_OTHER_CONTENTS)
			if (sameScope !== undefined) {
				// A crash after the record and before the recorded yes leaves it installed and unanswered: say yes now.
				const layerPath = recordLayerPath(layerOf(where.scope), { home, cwd: where.cwd })
				const own = readRecordLayer(layerPath)
				if (own.state !== 'unreadable' && !own.enabledPlugins.has(plan.id))
					setEnabledPlugin(layerPath, home, plan.id, true)
				return { outcome: 'already-installed', installPath: sameScope.installPath }
			}
		}

		let moved = false
		let wroteManifest = false
		let wroteRecord = false
		try {
			if (existing.length === 0) {
				// A folder here with no record is what a crash left behind; it is replaced.
				if (existsSync(dest)) trashFolder(home, dest)
				where.faults?.('before-move')
				mkdirSync(dirname(dest), { recursive: true, mode: 0o755 })
				renameSync(plan.root, dest)
				moved = true
				where.faults?.('after-move')
				writeJsonAtomic(installManifestPath(home, plan.id), manifestFile(plan, where))
				wroteManifest = true
				where.faults?.('after-manifest')
			}
			const installPath = existing.length > 0 ? (existing[0] as InstallRecord).installPath : dest
			putInstallRecord(
				home,
				plan.id,
				recordFields(plan, {
					scope: where.scope,
					installPath,
					...(projectPath !== undefined ? { projectPath } : {}),
					now: where.now.toISOString(),
				}),
			)
			wroteRecord = true
			where.faults?.('after-record')
			setEnabledPlugin(
				recordLayerPath(layerOf(where.scope), { home, cwd: where.cwd }),
				home,
				plan.id,
				true,
			)
			where.faults?.('after-enabled')
			return { outcome: 'installed', installPath }
		} catch (error) {
			if (!(error instanceof SimulatedCrash) && !wroteRecord) {
				// Nothing names the folder: put things back as they were, as far as this process can.
				if (wroteManifest) rmSync(installManifestPath(home, plan.id), { force: true })
				if (moved) trashFolder(home, dest)
			}
			throw error
		}
	})
}

export interface UpdateOutcome {
	readonly outcome: 'updated' | 'up-to-date'
	readonly from?: string
	readonly to: string
}

/**
 * Point every record of an installed plugin at a new version staged in `plan`.
 * The old folder stays, marked `.orphaned_at`, so a running session keeps its
 * files until `namzu plugin prune` takes it a day later.
 */
export function commitUpdate(
	plan: InstallPlan,
	where: WriteOptions & { consent: { by: string; nonInteractive: boolean } },
): UpdateOutcome {
	const { home } = where
	const dest = cacheFolderOf(home, plan)
	return withStateFileLock(installedPluginsPath(home), () => {
		const existing = readRecords(home).get(plan.id) ?? []
		if (existing.length === 0) throw new InstallConflict(`${plan.id} is not installed.`, 66)
		const current = existing[0] as InstallRecord
		const recorded = readInstallManifest(home, plan.id)
		const sameContents = recorded.state === 'ok' && recorded.manifest.surfaceSha256 === plan.digest
		if (current.version === plan.version) {
			if (sameContents) return { outcome: 'up-to-date', to: plan.version }
			throw new InstallConflict(
				`${plan.id} still says version ${plan.version} but its files changed. Ask its author to raise the version, or remove it and install it again.`,
			)
		}
		const oldPaths = new Set(existing.map((record) => realPathOrResolved(record.installPath)))
		let moved = false
		let wroteRecord = false
		const previousManifest = existsSync(installManifestPath(home, plan.id))
			? readFileSync(installManifestPath(home, plan.id))
			: undefined
		try {
			if (existsSync(dest)) trashFolder(home, dest)
			where.faults?.('before-move')
			mkdirSync(dirname(dest), { recursive: true, mode: 0o755 })
			renameSync(plan.root, dest)
			moved = true
			where.faults?.('after-move')
			const first = existing[0] as InstallRecord
			writeJsonAtomic(installManifestPath(home, plan.id), {
				...manifestFile(plan, {
					...where,
					scope: first.scope,
					cwd: first.projectPath ?? '',
				}),
			})
			where.faults?.('after-manifest')
			for (const record of existing) {
				putInstallRecord(home, plan.id, {
					...recordFields(plan, {
						scope: record.scope,
						installPath: dest,
						...(record.projectPath !== undefined ? { projectPath: record.projectPath } : {}),
						now: where.now.toISOString(),
					}),
					installedAt: record.installedAt ?? where.now.toISOString(),
				})
				wroteRecord = true
			}
			where.faults?.('after-record')
		} catch (error) {
			if (!(error instanceof SimulatedCrash) && !wroteRecord) {
				if (previousManifest !== undefined)
					writeFileSync(installManifestPath(home, plan.id), previousManifest, { mode: 0o600 })
				if (moved) trashFolder(home, dest)
			}
			throw error
		}
		for (const old of oldPaths) {
			if (samePath(old, dest) || !isInsidePluginCache(home, old)) continue
			try {
				writeFileSync(join(old, '.orphaned_at'), `${where.now.toISOString()}\n`, { mode: 0o600 })
			} catch {
				// A folder that is already gone needs no marker.
			}
		}
		return {
			outcome: 'updated',
			...(current.version !== undefined ? { from: current.version } : {}),
			to: plan.version,
		}
	})
}

export interface RemoveOptions extends WriteOptions {
	readonly deleteData: boolean
}

export interface RemoveOutcome {
	readonly removedRecord: boolean
	readonly folderRemoved: boolean
	readonly manifestRemoved: boolean
	readonly dataKept: boolean
	readonly dataDeleted: boolean
	/** Records of the id that remain at other scopes. */
	readonly remaining: number
}

/**
 * Remove one record of an installed plugin: the record first, then its
 * recorded yes, then (when no other record needs them) the install manifest
 * and the cache folder. Plugin data is kept unless `deleteData`, and then only
 * when this was the last record.
 */
export function removeInstall(
	id: string,
	which: { scope: RecordScope; projectPath?: string },
	options: RemoveOptions,
): RemoveOutcome {
	const { home } = options
	return withStateFileLock(installedPluginsPath(home), () => {
		const before = (readRecords(home).get(id) ?? []).find(
			(record) =>
				record.scope === which.scope &&
				(which.projectPath === undefined ||
					(record.projectPath !== undefined && samePath(record.projectPath, which.projectPath))),
		)
		if (before === undefined)
			return {
				removedRecord: false,
				folderRemoved: false,
				manifestRemoved: false,
				dataKept: false,
				dataDeleted: false,
				remaining: 0,
			}
		removeInstallRecord(home, id, {
			scope: which.scope,
			...(which.projectPath !== undefined ? { projectPath: which.projectPath } : {}),
		})
		try {
			setEnabledPlugin(
				recordLayerPath(layerOf(which.scope), { home, cwd: which.projectPath ?? home }),
				home,
				id,
				undefined,
			)
		} catch {
			// The record is gone; a stale `enabledPlugins` key names nothing installed and is harmless.
		}
		const remaining = readRecords(home)
		const left = remaining.get(id) ?? []
		let manifestRemoved = false
		const prior = readInstallManifest(home, id)
		const originSource = prior.state === 'ok' ? (prior.manifest.installedFrom ?? null) : null
		if (left.length === 0 && existsSync(installManifestPath(home, id))) {
			rmSync(installManifestPath(home, id), { force: true })
			manifestRemoved = true
		}
		const usedElsewhere = [...remaining.values()]
			.flat()
			.some((record) => samePath(record.installPath, before.installPath))
		let folderRemoved = false
		// A record that points outside the cache is dropped; the folder is not ours to delete.
		if (
			!usedElsewhere &&
			existsSync(before.installPath) &&
			isInsidePluginCache(home, before.installPath)
		) {
			trashFolder(home, before.installPath)
			folderRemoved = true
			removeEmptyParents(before.installPath, pluginCacheFolder(home))
		}
		const data = installedPluginDataFolder(home, id)
		let dataKept = false
		let dataDeleted = false
		if (left.length === 0 && existsSync(data)) {
			if (options.deleteData) {
				trashFolder(home, data)
				dataDeleted = true
			} else {
				dataKept = true
				try {
					writeFileSync(
						join(data, '.origin.json'),
						`${JSON.stringify({ id, removedAt: options.now.toISOString(), source: originSource }, null, 2)}\n`,
						{ mode: 0o600 },
					)
				} catch {
					// Keeping the data is what matters; the stamp is a courtesy.
				}
			}
		}
		return {
			removedRecord: true,
			folderRemoved,
			manifestRemoved,
			dataKept,
			dataDeleted,
			remaining: left.length,
		}
	})
}

function removeIfEmpty(dir: string): void {
	try {
		if (readdirSync(dir).length === 0) rmdirSync(dir)
	} catch {
		// Not empty, or gone.
	}
}

function removeEmptyParents(from: string, stop: string): void {
	let dir = dirname(from)
	while (dir.length > stop.length && dir.startsWith(stop)) {
		try {
			if (readdirSync(dir).length > 0) return
			rmdirSync(dir)
		} catch {
			return
		}
		dir = dirname(dir)
	}
}

export interface PruneItem {
	readonly path: string
	readonly kind: 'cache-version' | 'install-manifest' | 'staging'
	readonly reason: string
}

export interface PruneResult {
	readonly items: readonly PruneItem[]
	/** Orphans kept because they were marked less than a day ago. */
	readonly kept: readonly { readonly path: string; readonly reason: string }[]
}

const DAY_MS = 24 * 60 * 60 * 1000
const STAGING_GRACE_MS = 60 * 60 * 1000

function readMarker(dir: string): number | undefined {
	try {
		const at = Date.parse(readFileSync(join(dir, '.orphaned_at'), 'utf8').trim())
		return Number.isNaN(at) ? undefined : at
	} catch {
		return undefined
	}
}

function listDirs(path: string): string[] {
	try {
		return readdirSync(path, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(path, entry.name))
	} catch {
		return []
	}
}

function findPrunable(home: string, now: Date): PruneResult {
	const records = readRecords(home)
	const used = new Set<string>()
	for (const list of records.values())
		for (const r of list) used.add(realPathOrResolved(r.installPath))
	const items: PruneItem[] = []
	const kept: { path: string; reason: string }[] = []
	for (const market of listDirs(pluginCacheFolder(home)))
		for (const plugin of listDirs(market))
			for (const version of listDirs(plugin)) {
				if (used.has(realPathOrResolved(version))) continue
				const marked = readMarker(version)
				if (marked === undefined)
					items.push({ path: version, kind: 'cache-version', reason: 'no install record names it' })
				else if (now.getTime() - marked >= DAY_MS)
					items.push({
						path: version,
						kind: 'cache-version',
						reason: 'an older version that was replaced more than a day ago',
					})
				else kept.push({ path: version, reason: 'an older version replaced less than a day ago' })
			}
	try {
		for (const file of readdirSync(installManifestsFolder(home))) {
			if (!file.endsWith('.json')) continue
			const id = file.slice(0, -'.json'.length)
			if (!records.has(id))
				items.push({
					path: join(installManifestsFolder(home), file),
					kind: 'install-manifest',
					reason: 'no install record names it',
				})
		}
	} catch {
		// No manifests folder yet.
	}
	for (const entry of listAll(stagingFolder(home))) {
		try {
			if (now.getTime() - statSync(entry).mtimeMs >= STAGING_GRACE_MS)
				items.push({
					path: entry,
					kind: 'staging',
					reason: 'left over from an install that did not finish',
				})
		} catch {
			// Gone already.
		}
	}
	return { items, kept }
}

function listAll(path: string): string[] {
	try {
		return readdirSync(path).map((name) => join(path, name))
	} catch {
		return []
	}
}

/**
 * What `prune` would remove, and with `apply` removes it, holding the install
 * record's lock so an install in another process is never caught half way.
 * Nothing here runs on a timer: only the explicit command.
 */
export function prune(home: string, now: Date, apply: boolean): PruneResult {
	if (!apply) return findPrunable(home, now)
	return withStateFileLock(installedPluginsPath(home), () => {
		const result = findPrunable(home, now)
		for (const item of result.items) {
			if (item.kind === 'install-manifest') rmSync(item.path, { force: true })
			else trashFolder(home, item.path)
		}
		for (const market of listDirs(pluginCacheFolder(home))) {
			for (const plugin of listDirs(market)) removeIfEmpty(plugin)
			removeIfEmpty(market)
		}
		return result
	})
}
