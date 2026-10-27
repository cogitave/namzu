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
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { compareVersions } from '../updates.js'
import type { InstallKind } from './install-kind.js'
import {
	LOCK_STALE_MS,
	type UpdateLock,
	updatesDir,
	acquireUpdateLock,
	clearInProgress,
	installScope,
	previousDir,
	processIsRunning,
	pruneOlderPrevious,
	readInProgress,
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
	/** Start the installed copy once; true when it answers with `version`. */
	readonly smokeTest?: (root: string, version: string) => Promise<boolean>
	readonly registry?: string
	readonly removePowerShellShim?: (prefix: string) => void
	readonly pid?: number
	readonly now?: () => number
	readonly isAlive?: (pid: number) => boolean
	readonly installTimeoutMs?: number
}

export interface Release {
	readonly version: string
	readonly integrity?: string | undefined
}

/** The arguments that put exactly `version` into an npm global prefix. */
export function npmInstallArgs(
	prefix: string,
	version: string,
	registry = PUBLIC_REGISTRY,
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
		`@namzu/cli@${version}`,
	]
}

export function pnpmInstallArgs(version: string, registry = PUBLIC_REGISTRY): string[] {
	return ['add', '--global', '--registry', registry, `@namzu/cli@${version}`]
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

export function classifyInstallerFailure(output: string): FailureStatus {
	if (/EINTEGRITY|integrity checksum failed|sha512-.*(?:mismatch|expected)/i.test(output))
		return 'integrity'
	if (/EACCES|EPERM|permission denied|operation not permitted/i.test(output)) return 'no_permission'
	if (/EBUSY|ETXTBSY|resource busy|text file busy/i.test(output)) return 'in_use'
	if (/ENOSPC|no space left/i.test(output)) return 'disk_full'
	if (/ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network|fetch failed/i.test(output))
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

/** Start the installed copy once and see that it names the version it should be. */
export function smokeTestInstalled(root: string, version: string): Promise<boolean> {
	return new Promise((resolve) => {
		let entry = join(root, 'dist', 'bin.js')
		try {
			const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
				bin?: string | Record<string, string>
			}
			const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.namzu
			if (bin) entry = join(root, bin)
		} catch {
			resolve(false)
			return
		}
		execFile(
			process.execPath,
			[entry, '--version'],
			{
				timeout: 45_000,
				windowsHide: true,
				env: { ...process.env, NAMZU_AUTO_UPDATE: '0', NAMZU_UPDATE_CHECK: '0' },
			},
			(error, stdout) => resolve(!error && stdout.trim() === version),
		)
	})
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
			home: deps.home,
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
	const { install } = deps
	const registry = deps.registry ?? PUBLIC_REGISTRY
	let backup: string | undefined
	const pid = deps.pid ?? process.pid
	const at = (deps.now ?? Date.now)()
	const scope = scopeOf(install, deps.platform)
	const logFile = installLogPath(deps.home, scope)
	try {
		writeInProgress(deps.home, { pid, to: release.version, from: onDisk, at }, scope)
		if (install.kind === 'npm-global') {
			backup = backupPackage(install.root, deps.home, onDisk, scope)
			writeInProgress(deps.home, { pid, to: release.version, from: onDisk, backup, at }, scope)
		}
	} catch {
		clearInProgress(deps.home, scope)
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
			let output = ''
			const code = await deps.runInstaller({
				executable: 'pnpm',
				args: pnpmInstallArgs(onDisk, registry),
				cwd: install.globalDir,
				onOutput: (text) => {
					output = (output + text).slice(-4_096)
				},
				logFile: installLogPath(deps.home, scope, 'restore'),
				timeoutMs: deps.installTimeoutMs ?? 300_000,
			})
			return code === 0 && deps.installedVersion(activeRoot(install)) === onDisk
		} catch {
			return false
		}
	}

	// The installer runs on its own when this process goes away, so the marker
	// names it: a later start must not touch the folder while it still writes.
	const noteInstaller = (installerPid: number): void => {
		try {
			writeInProgress(
				deps.home,
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
						args: npmInstallArgs(install.prefix, release.version, registry),
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
						args: pnpmInstallArgs(release.version, registry),
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
		const kind = classifyInstallerFailure(output)
		const restored = await restoreIfChanged(deps, onDisk, restore)
		if (restored) clearInProgress(deps.home, scope)
		return fail(kind, restored, logFile)
	}

	let installed: string
	try {
		installed = deps.installedVersion(activeRoot(install))
	} catch {
		installed = ''
	}
	const smoke = deps.smokeTest ?? smokeTestInstalled
	const healthy =
		installed === release.version && (await smoke(activeRoot(install), release.version))
	if (!healthy) {
		const restored = await restore()
		if (restored) clearInProgress(deps.home, scope)
		return fail('verify_failed', restored, logFile)
	}
	clearInProgress(deps.home, scope)

	if (deps.platform === 'win32' && install.kind === 'npm-global') {
		try {
			deps.removePowerShellShim?.(install.prefix)
		} catch {
			// namzu.cmd still works.
		}
	}
	pruneOlderPrevious(deps.home, 2, scope)
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
			if (await smoke(activeRoot(deps.install), onDisk)) return true
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
	const marker = readInProgress(deps.home, scope)
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
			home: deps.home,
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
		const root = activeRoot(install)
		const smoke = deps.smokeTest ?? smokeTestInstalled
		const ids = { from: marker.from, to: marker.to }
		let healthy = false
		try {
			const now = deps.installedVersion(root)
			healthy = (now === marker.to || now === marker.from) && (await smoke(root, now))
		} catch {
			healthy = false
		}
		if (healthy) {
			clearInProgress(deps.home, scope)
			return deps.installedVersion(root) === marker.to
				? { status: 'completed', ...ids }
				: { status: 'unchanged', ...ids }
		}
		let restored = false
		try {
			if (
				install.kind === 'npm-global' &&
				marker.backup &&
				isKeptCopy(deps.home, marker.backup) &&
				existsSync(marker.backup)
			) {
				restorePackage(install.root, marker.backup, own)
				restored = deps.installedVersion(root) === marker.from
			} else if (install.kind === 'pnpm-global') {
				const code = await deps.runInstaller({
					executable: 'pnpm',
					args: pnpmInstallArgs(marker.from, deps.registry ?? PUBLIC_REGISTRY),
					cwd: install.globalDir,
					onOutput: () => undefined,
					logFile: installLogPath(deps.home, scope, 'restore'),
					timeoutMs: deps.installTimeoutMs ?? 300_000,
				})
				restored = code === 0 && deps.installedVersion(root) === marker.from
			}
		} catch {
			restored = false
		}
		if (restored) clearInProgress(deps.home, scope)
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
