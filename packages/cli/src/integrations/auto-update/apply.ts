/**
 * Replace the running installation with a newer version, safely.
 *
 * The order is the safety: take the lock, keep a copy of the package being
 * replaced, let the package manager install the exact version (it checks the
 * registry's digest), read the installed version back, start the new copy once
 * to see that it answers, and put the old copy back if any of that fails. The
 * running process is never touched; the next start uses the new version.
 */

import { execFile } from 'node:child_process'
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { compareVersions } from '../updates.js'
import { DownloadError, downloadVerifiedTarball } from './download.js'
import type { InstallKind } from './install-kind.js'
import { START_CHECK_FLAG } from './start-check.js'
import {
	LOCK_STALE_MS,
	type UpdateLock,
	acquireUpdateLock,
	clearInProgress,
	installScope,
	previousDir,
	processIsRunning,
	pruneOlderPrevious,
	readInProgress,
	updatesDir,
	writeInProgress,
} from './state.js'

/** The folder whose package.json says which version is active now (for pnpm, the link it repoints). */
export function activeRoot(
	install: Extract<InstallKind, { kind: 'npm-global' | 'pnpm-global' }>,
): string {
	return install.kind === 'pnpm-global'
		? join(install.globalDir, 'node_modules', '@namzu', 'cli')
		: install.root
}

/** The key an install's lock, marker and kept copies are filed under: its prefix, or pnpm's global folder. */
export function scopeOf(
	install: Extract<InstallKind, { kind: 'npm-global' | 'pnpm-global' }>,
	platform: NodeJS.Platform = process.platform,
): string {
	return installScope(install.kind === 'pnpm-global' ? install.globalDir : install.prefix, platform)
}

/**
 * Where the lock and the in-progress marker of an install live: inside the install
 * itself, which must be writable for an update to run at all. Every process that can
 * write the install, whatever its Namzu home or user, sees the same files.
 */
export function sharedStateHome(
	install: Extract<InstallKind, { kind: 'npm-global' | 'pnpm-global' }>,
): string {
	return join(install.kind === 'pnpm-global' ? install.globalDir : install.prefix, '.namzu-update')
}

export const PUBLIC_REGISTRY = 'https://registry.npmjs.org'

export type FailureStatus =
	| 'no_permission'
	| 'in_use'
	| 'unverifiable'
	| 'integrity'
	| 'network'
	| 'disk_full'
	| 'install_failed'
	| 'verify_failed'
	| 'backup_failed'

export type ApplyResult =
	| { readonly status: 'installed'; readonly from: string; readonly to: string }
	/** Another process already put this version on disk; only a restart is left. */
	| { readonly status: 'already'; readonly to: string }
	| { readonly status: 'locked' }
	| {
			readonly status: 'failed'
			readonly code: FailureStatus
			readonly detail: string
			/** The installer's log, when one was written. */
			readonly log?: string
			/** The previous version is in place and works. */
			readonly restored: boolean
	  }

export interface InstallerRequest {
	readonly executable: string
	readonly args: readonly string[]
	readonly cwd: string
	readonly onOutput: (text: string) => void
	/**
	 * Where the installer's output goes while it runs, and where the end of it is read
	 * back from. A file keeps the installer alive when this process (and its terminal)
	 * goes away first; a pipe would end it with a broken-pipe error.
	 */
	readonly logFile?: string
	/** Kill the installer after this long. */
	readonly timeoutMs: number
	/** Called with the installer's process id once it has started. */
	readonly onSpawn?: (pid: number) => void
}

export interface ApplyDeps {
	readonly home: string
	readonly install: Extract<InstallKind, { kind: 'npm-global' | 'pnpm-global' }>
	readonly currentVersion: string
	readonly platform: NodeJS.Platform
	/** Run the package manager; resolves with its exit code. */
	readonly runInstaller: (request: InstallerRequest) => Promise<number>
	/** Version the package folder on disk reports. Throws when unreadable. */
	readonly installedVersion: (root: string) => string
	/**
	 * Start the installed copy once; true when it answers with `version` and, at the
	 * `session` depth, can load what a session needs.
	 */
	readonly smokeTest?: (root: string, version: string, depth?: SmokeDepth) => Promise<boolean>
	readonly registry?: string
	readonly removePowerShellShim?: (prefix: string) => void
	readonly pid?: number
	readonly now?: () => number
	readonly isAlive?: (pid: number) => boolean
	readonly installTimeoutMs?: number
	/**
	 * Put the release tarball at `file`, checked against the release's digest;
	 * throws a {@link DownloadError} when it cannot be fetched or does not match.
	 * Left out, it is downloaded from the registry the release came from.
	 */
	readonly fetchTarball?: (release: Release, file: string) => Promise<void>
}

export interface Release {
	readonly version: string
	readonly integrity?: string | undefined
	/** The registry's address for the tarball. */
	readonly tarball?: string | undefined
}

/** Where the verified tarball of a release is kept while it is installed. */
export function tarballPath(home: string, scope: string, version: string): string {
	return join(updatesDir(home), 'download', `namzu-cli-${version}-${scope}.tgz`)
}

/**
 * The arguments that put one version into an npm global prefix. With a checked
 * tarball the package manager installs that file, so what it unpacks is what was
 * checked; the registry settings then only apply to the package's own
 * dependencies, and the `@namzu` scope is pinned to the registry the release came
 * from. Without one it asks the registry for the exact version (going back to a
 * version the machine already has).
 */
export function npmInstallArgs(
	prefix: string,
	version: string,
	registry = PUBLIC_REGISTRY,
	tarball?: string,
): string[] {
	return [
		'install',
		'--global',
		'--prefix',
		prefix,
		'--no-fund',
		'--no-audit',
		'--registry',
		registry,
		...(tarball ? [`--@namzu:registry=${registry}`] : []),
		tarball ?? `@namzu/cli@${version}`,
	]
}

export function pnpmInstallArgs(
	version: string,
	registry = PUBLIC_REGISTRY,
	tarball?: string,
	mode: 'online' | 'offline' | 'prefer-offline' = 'online',
): string[] {
	return [
		'add',
		'--global',
		...(mode === 'online' ? [] : [`--${mode}`]),
		'--registry',
		registry,
		// The scope is pinned for every form, so a scoped registry in the person's or a
		// project's .npmrc cannot decide where the package is resolved from.
		`--@namzu:registry=${registry}`,
		tarball ?? `@namzu/cli@${version}`,
	]
}

/** Runs pnpm with these arguments in the global folder; resolves with its exit code. */
export type PnpmRun = (args: readonly string[]) => Promise<number>

/**
 * Record the registry's name for a version in pnpm's global manifest. A tarball path
 * leaves a `file:` entry that points at a file deleted afterwards, and pnpm then
 * skips the package on every later update. The verified bytes are already in the
 * store, so this links them from there and never fetches: offline, so that what ends
 * up installed is the hashed copy. Resolves false when the store cannot serve it,
 * and the caller then leaves the file entry as it is.
 */
export async function settlePnpmByName(
	run: PnpmRun,
	version: string,
	registry: string,
): Promise<boolean> {
	try {
		return (await run(pnpmInstallArgs(version, registry, undefined, 'offline'))) === 0
	} catch {
		return false
	}
}

/**
 * Put a version back through pnpm. The store still holds it, so it is tried offline
 * first, which needs no registry at all; only when the store lacks it is the registry asked.
 */
export async function reinstallPnpm(
	run: PnpmRun,
	version: string,
	registry: string,
): Promise<boolean> {
	for (const mode of ['offline', 'online'] as const) {
		try {
			if ((await run(pnpmInstallArgs(version, registry, undefined, mode))) === 0) return true
		} catch {
			// Try the next way.
		}
	}
	return false
}

/** Adapt the background installer to the plain runner the shared pnpm steps take. */
function pnpmRunner(
	deps: Pick<ApplyDeps, 'runInstaller' | 'installTimeoutMs'>,
	cwd: string,
	logFile: string,
	onSpawn?: (pid: number) => void,
): PnpmRun {
	return (args) =>
		deps.runInstaller({
			executable: 'pnpm',
			args,
			cwd,
			onOutput: () => undefined,
			logFile,
			timeoutMs: deps.installTimeoutMs ?? 300_000,
			...(onSpawn ? { onSpawn } : {}),
		})
}

/** Delete verified downloads this install left behind (an installer that outlived its parent). */
export function pruneStaleDownloads(home: string, scope: string, keep: string): void {
	const dir = join(updatesDir(home), 'download')
	try {
		for (const name of readdirSync(dir)) {
			if (name.endsWith(`-${scope}.tgz`) && join(dir, name) !== keep)
				rmSync(join(dir, name), { force: true })
		}
	} catch {
		// Nothing kept, or a folder that cannot be listed.
	}
}

/** The exact command a person can run when Namzu may not do it for them. */
export function manualUpdateCommand(
	install: InstallKind,
	version: string,
	platform: NodeJS.Platform,
): string | null {
	if (install.kind === 'npm-global') {
		const base = `npm install --global --prefix ${quoteIfNeeded(install.prefix)} @namzu/cli@${version}`
		return install.writable ? 'namzu upgrade' : platform === 'win32' ? base : `sudo ${base}`
	}
	if (install.kind === 'pnpm-global') return `pnpm add --global @namzu/cli@${version}`
	return null
}

function quoteIfNeeded(value: string): string {
	return /[\s"'$`\\]/.test(value) && !/^[A-Za-z]:\\/.test(value)
		? `'${value.replace(/'/g, `'\\''`)}'`
		: /\s/.test(value)
			? `"${value}"`
			: value
}

export function classifyInstallerFailure(
	output: string,
	platform: NodeJS.Platform = process.platform,
): FailureStatus {
	if (/EINTEGRITY|integrity checksum failed|sha512-.*(?:mismatch|expected)/i.test(output))
		return 'integrity'
	// On Windows a scanner or a program holding a file open reports EPERM for a moment.
	if (/EBUSY|ETXTBSY|resource busy|text file busy/i.test(output)) return 'in_use'
	if (platform === 'win32' && /EPERM/.test(output)) return 'in_use'
	if (/EACCES|EPERM|permission denied|operation not permitted/i.test(output)) return 'no_permission'
	if (/ENOSPC|no space left/i.test(output)) return 'disk_full'
	if (
		/ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ENETDOWN|EHOSTUNREACH|ERR_SOCKET_TIMEOUT|fetch failed/i.test(
			output,
		)
	)
		return 'network'
	return 'install_failed'
}

/** Plain words for a failure, for the last-result record and `namzu upgrade --check`. */
export function describeFailure(code: FailureStatus): string {
	switch (code) {
		case 'no_permission':
			return 'Namzu may not write to the folder it is installed in.'
		case 'in_use':
			return 'A file of the installed copy is in use by another program.'
		case 'unverifiable':
			return 'The registry did not give a checksum for the new version, so it was not installed.'
		case 'integrity':
			return 'The download did not match its checksum, so it was not installed.'
		case 'network':
			return 'The download was interrupted.'
		case 'disk_full':
			return 'There is not enough free disk space.'
		case 'backup_failed':
			return 'A copy of the current version could not be kept, so nothing was changed.'
		case 'verify_failed':
			return 'The new version did not start, so the previous one was put back.'
		default:
			return 'The installer did not finish.'
	}
}

/** Keep a copy of the package folder that is about to be replaced. */
export function backupPackage(root: string, home: string, version: string, scope?: string): string {
	const target = previousDir(home, version, scope)
	rmSync(target, { recursive: true, force: true })
	mkdirSync(join(target, '..'), { recursive: true })
	cpSync(root, target, { recursive: true, verbatimSymlinks: true })
	return target
}

/** Put a kept copy back in place of whatever the installer left. */
export function restorePackage(root: string, backup: string, pid = process.pid): void {
	// Copy beside the folder first and swap by rename, so a crash or a locked file
	// never leaves the package missing: the old folder is only moved aside.
	const fresh = `${root}.restore-${pid}`
	const aside = `${root}.replaced-${pid}`
	rmSync(fresh, { recursive: true, force: true })
	rmSync(aside, { recursive: true, force: true })
	try {
		cpSync(backup, fresh, { recursive: true, verbatimSymlinks: true })
		const hadRoot = existsSync(root)
		if (hadRoot) renameSync(root, aside)
		try {
			renameSync(fresh, root)
		} catch (error) {
			if (hadRoot) renameSync(aside, root)
			throw error
		}
	} finally {
		rmSync(fresh, { recursive: true, force: true })
		rmSync(aside, { recursive: true, force: true })
	}
}

/**
 * How much a start check asks of an installed copy. `version` is whether it starts and
 * names its version; `session` also asks it to load what a terminal session needs.
 */
export type SmokeDepth = 'version' | 'session'

/**
 * Start the installed copy and see that it names the version it should be and, at the
 * `session` depth, that it can load what a session needs. A copy from before the second
 * question existed is only ever asked the first (the `version` depth), which is what is
 * used to check a version that is being put back.
 */
export async function smokeTestInstalled(
	root: string,
	version: string,
	depth: SmokeDepth = 'session',
): Promise<boolean> {
	let entry = join(root, 'dist', 'bin.js')
	try {
		const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
			bin?: string | Record<string, string>
		}
		const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.namzu
		if (bin) entry = join(root, bin)
	} catch {
		return false
	}
	const run = (arg: string): Promise<string | null> =>
		new Promise((resolve) => {
			execFile(
				process.execPath,
				[entry, arg],
				{
					timeout: 45_000,
					windowsHide: true,
					env: { ...process.env, NAMZU_AUTO_UPDATE: '0', NAMZU_UPDATE_CHECK: '0' },
				},
				(error, stdout) => resolve(error ? null : stdout.trim()),
			)
		})
	if ((await run('--version')) !== version) return false
	return depth === 'version' || (await run(START_CHECK_FLAG)) === 'ok'
}

export async function applyUpdate(deps: ApplyDeps, release: Release): Promise<ApplyResult> {
	const { install } = deps
	if (!release.integrity) {
		return fail('unverifiable', true)
	}
	let onDisk: string
	try {
		onDisk = deps.installedVersion(activeRoot(install))
	} catch {
		return fail('install_failed', true)
	}
	if (compareVersions(onDisk, release.version) >= 0) return { status: 'already', to: onDisk }
	if (!install.writable) return fail('no_permission', true)

	let lock: UpdateLock | null
	try {
		lock = acquireUpdateLock({
			home: sharedStateHome(install),
			scope: scopeOf(install, deps.platform),
			...(deps.pid !== undefined ? { pid: deps.pid } : {}),
			...(deps.now ? { now: deps.now } : {}),
			...(deps.isAlive ? { isAlive: deps.isAlive } : {}),
		})
	} catch {
		return fail('backup_failed', true)
	}
	if (!lock) return { status: 'locked' }
	try {
		return await applyLocked(deps, release, onDisk)
	} finally {
		lock.release()
	}
}

function fail(code: FailureStatus, restored: boolean, log?: string): ApplyResult {
	const lost = restored
		? ''
		: ' The previous version could not be put back; reinstall Namzu if it does not start.'
	return {
		status: 'failed',
		code,
		detail: `${describeFailure(code)}${lost}`,
		restored,
		...(log ? { log } : {}),
	}
}

/** Where an install's output is kept: one file per install, replaced on each run. */
export function installLogPath(home: string, scope: string, name = 'install'): string {
	return join(updatesDir(home), `${name}-${scope}.log`)
}

async function applyLocked(
	deps: ApplyDeps,
	release: Release,
	onDisk: string,
): Promise<ApplyResult> {
	const registry = deps.registry ?? PUBLIC_REGISTRY
	const scope = scopeOf(deps.install, deps.platform)
	const logFile = installLogPath(deps.home, scope)

	// Fetch and check the release before anything on disk is touched: a download that
	// fails or does not match costs nothing to undo.
	const tarball = tarballPath(deps.home, scope, release.version)
	pruneStaleDownloads(deps.home, scope, tarball)
	try {
		await (deps.fetchTarball ?? fetchFromRegistry(registry))(release, tarball)
	} catch (error) {
		try {
			rmSync(tarball, { force: true })
		} catch {
			// A home that cannot even hold the download has nothing to clean.
		}
		const code = error instanceof DownloadError ? error.code : 'network'
		return fail(code, true)
	}
	try {
		return await installFromTarball(deps, release, onDisk, tarball, scope, logFile)
	} finally {
		rmSync(tarball, { force: true })
	}
}

/** The default way to get a verified tarball: from the registry the release was learned from. */
export function fetchFromRegistry(
	registry: string,
): (release: Release, file: string) => Promise<void> {
	return async (release, file) => {
		if (!release.integrity || !release.tarball) {
			throw new DownloadError('unverifiable', 'the registry gave no checksum or address')
		}
		await downloadVerifiedTarball({
			url: release.tarball,
			integrity: release.integrity,
			registry,
			destination: file,
		})
	}
}

async function installFromTarball(
	deps: ApplyDeps,
	release: Release,
	onDisk: string,
	tarball: string,
	scope: string,
	logFile: string,
): Promise<ApplyResult> {
	const { install } = deps
	const shared = sharedStateHome(install)
	const registry = deps.registry ?? PUBLIC_REGISTRY
	let backup: string | undefined
	const pid = deps.pid ?? process.pid
	const at = (deps.now ?? Date.now)()
	try {
		writeInProgress(shared, { pid, to: release.version, from: onDisk, at }, scope)
		if (install.kind === 'npm-global') {
			backup = backupPackage(install.root, shared, onDisk, scope)
			writeInProgress(shared, { pid, to: release.version, from: onDisk, backup, at }, scope)
		}
	} catch {
		clearInProgress(shared, scope)
		return fail('backup_failed', true)
	}

	const restore = async (): Promise<boolean> => {
		try {
			if (install.kind === 'npm-global') {
				if (!backup) return false
				restorePackage(install.root, backup, deps.pid)
				return true
			}
			// pnpm keeps the old version in its store: installing it again is a link, not a download.
			const smoke = deps.smokeTest ?? smokeTestInstalled
			return (
				(await reinstallPnpm(
					pnpmRunner(deps, install.globalDir, installLogPath(deps.home, scope, 'restore')),
					onDisk,
					registry,
				)) &&
				deps.installedVersion(activeRoot(install)) === onDisk &&
				(await smoke(activeRoot(install), onDisk, 'version'))
			)
		} catch {
			return false
		}
	}

	// The installer runs on its own when this process goes away, so the marker
	// names it: a later start must not touch the folder while it still writes.
	const noteInstaller = (installerPid: number): void => {
		try {
			writeInProgress(
				shared,
				{
					pid,
					to: release.version,
					from: onDisk,
					...(backup ? { backup } : {}),
					installerPid,
					at,
				},
				scope,
			)
		} catch {
			// The marker written before the install still stands.
		}
	}

	let output = ''
	let code: number
	try {
		code = await deps.runInstaller(
			install.kind === 'npm-global'
				? {
						executable: deps.platform === 'win32' ? 'npm.cmd' : 'npm',
						args: npmInstallArgs(install.prefix, release.version, registry, tarball),
						cwd: install.prefix,
						onOutput: (text) => {
							output = (output + text).slice(-16_384)
						},
						timeoutMs: deps.installTimeoutMs ?? 300_000,
						logFile,
						onSpawn: noteInstaller,
					}
				: {
						executable: 'pnpm',
						args: pnpmInstallArgs(release.version, registry, tarball),
						cwd: install.globalDir,
						onOutput: (text) => {
							output = (output + text).slice(-16_384)
						},
						timeoutMs: deps.installTimeoutMs ?? 300_000,
						logFile,
						onSpawn: noteInstaller,
					},
		)
	} catch {
		code = 1
		output = 'spawn failed'
	}
	if (code !== 0) {
		const kind = classifyInstallerFailure(output, deps.platform)
		const restored = await restoreIfChanged(deps, onDisk, restore)
		if (restored) clearInProgress(shared, scope)
		return fail(kind, restored, logFile)
	}

	// A tarball path leaves a `file:` entry in pnpm's global manifest that points at a file
	// deleted below, and pnpm then skips the package on every later update. Record the
	// registry's name for the version instead, from the store only. When the store cannot
	// serve it the update stands as installed and the file entry stays.
	if (install.kind === 'pnpm-global') {
		await settlePnpmByName(
			pnpmRunner(deps, install.globalDir, logFile, noteInstaller),
			release.version,
			registry,
		)
	}

	let installed: string
	try {
		installed = deps.installedVersion(activeRoot(install))
	} catch {
		installed = ''
	}
	const smoke = deps.smokeTest ?? smokeTestInstalled
	const healthy =
		installed === release.version && (await smoke(activeRoot(install), release.version, 'session'))
	if (!healthy) {
		const restored = await restore()
		if (restored) clearInProgress(shared, scope)
		return fail('verify_failed', restored, logFile)
	}
	clearInProgress(shared, scope)

	if (deps.platform === 'win32' && install.kind === 'npm-global') {
		try {
			deps.removePowerShellShim?.(install.prefix)
		} catch {
			// namzu.cmd still works.
		}
	}
	pruneOlderPrevious(sharedStateHome(install), 2, scope)
	return { status: 'installed', from: onDisk, to: release.version }
}

/** After a failed install, restore only when the installer left something other than the old version. */
async function restoreIfChanged(
	deps: ApplyDeps,
	onDisk: string,
	restore: () => Promise<boolean>,
): Promise<boolean> {
	try {
		if (deps.installedVersion(activeRoot(deps.install)) === onDisk) {
			const smoke = deps.smokeTest ?? smokeTestInstalled
			if (await smoke(activeRoot(deps.install), onDisk, 'version')) return true
		}
	} catch {
		// Fall through to a restore.
	}
	return restore()
}

export type RepairResult =
	| { readonly status: 'none' }
	/** The installer is, or may be, still running in another process. */
	| { readonly status: 'busy' }
	/** The interrupted update turned out complete and healthy. */
	| { readonly status: 'completed'; readonly from: string; readonly to: string }
	/** The folder was broken or unverified; the previous version is back. */
	| { readonly status: 'restored'; readonly from: string; readonly to: string }
	/** The update never reached the folder and the installed version answers; nothing changed. */
	| { readonly status: 'unchanged'; readonly from: string; readonly to: string }
	/** The previous version could not be put back. */
	| { readonly status: 'unrepaired'; readonly from: string; readonly to: string }

/**
 * Finish what an interrupted update left: a marker whose process is gone means
 * the read-back, start check and restore never ran. Check the installed copy
 * now and put the kept one back when it does not answer.
 */
export async function repairInterruptedUpdate(
	deps: Omit<ApplyDeps, 'currentVersion'>,
): Promise<RepairResult> {
	const scope = scopeOf(deps.install, deps.platform)
	const marker = readInProgress(sharedStateHome(deps.install), scope)
	if (!marker) return { status: 'none' }
	const own = deps.pid ?? process.pid
	// A marker older than the lock window is dead whatever its pids say: a pid
	// can be reused by an unrelated program.
	const fresh = (deps.now ?? Date.now)() - marker.at <= LOCK_STALE_MS
	if (fresh && marker.pid !== own && processIsRunning(marker.pid)) return { status: 'busy' }
	if (fresh && marker.installerPid !== undefined && processIsRunning(marker.installerPid))
		return { status: 'busy' }
	let lock: UpdateLock | null
	try {
		lock = acquireUpdateLock({
			home: sharedStateHome(deps.install),
			scope,
			pid: own,
			...(deps.now ? { now: deps.now } : {}),
			...(deps.isAlive ? { isAlive: deps.isAlive } : {}),
		})
	} catch {
		return { status: 'busy' }
	}
	if (!lock) return { status: 'busy' }
	try {
		const { install } = deps
		const shared = sharedStateHome(install)
		const root = activeRoot(install)
		const smoke = deps.smokeTest ?? smokeTestInstalled
		const ids = { from: marker.from, to: marker.to }
		let healthy = false
		try {
			const now = deps.installedVersion(root)
			healthy =
				(now === marker.to || now === marker.from) &&
				(await smoke(root, now, now === marker.to ? 'session' : 'version'))
		} catch {
			healthy = false
		}
		if (healthy) {
			clearInProgress(shared, scope)
			return deps.installedVersion(root) === marker.to
				? { status: 'completed', ...ids }
				: { status: 'unchanged', ...ids }
		}
		let restored = false
		try {
			if (
				install.kind === 'npm-global' &&
				marker.backup &&
				isKeptCopy(shared, marker.backup) &&
				existsSync(marker.backup)
			) {
				restorePackage(install.root, marker.backup, own)
				restored = deps.installedVersion(root) === marker.from
			} else if (install.kind === 'pnpm-global') {
				restored =
					(await reinstallPnpm(
						pnpmRunner(deps, install.globalDir, installLogPath(deps.home, scope, 'restore')),
						marker.from,
						deps.registry ?? PUBLIC_REGISTRY,
					)) &&
					deps.installedVersion(root) === marker.from &&
					(await smoke(root, marker.from, 'version'))
			}
		} catch {
			restored = false
		}
		if (restored) clearInProgress(shared, scope)
		return { status: restored ? 'restored' : 'unrepaired', ...ids }
	} finally {
		lock.release()
	}
}

/** Only a folder under `updates/previous` may be put back over the package. */
function isKeptCopy(home: string, backup: string): boolean {
	const base = resolve(previousDir(home, 'x'), '..')
	const rel = relative(base, resolve(backup))
	return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}
