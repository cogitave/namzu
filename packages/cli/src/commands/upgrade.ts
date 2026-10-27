import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

import type { UpdateChannel } from '../config/schema.js'
import { EXIT_FAIL, EXIT_OK, EXIT_UNAVAILABLE, EXIT_USAGE } from '../exit-codes.js'
import {
	PUBLIC_REGISTRY,
	backupPackage,
	describeFailure,
	fetchFromRegistry,
	npmInstallArgs,
	pnpmInstallArgs,
	pruneStaleDownloads,
	reinstallPnpm,
	restorePackage,
	settlePnpmByName,
	smokeTestInstalled,
	tarballPath,
} from '../integrations/auto-update/apply.js'
import { DownloadError } from '../integrations/auto-update/download.js'
import { pnpmGlobalDirFor } from '../integrations/auto-update/install-kind.js'
import { resolveUpdatePolicy } from '../integrations/auto-update/policy.js'
import {
	acquireUpdateLock,
	clearInProgress,
	installScope,
	pruneOlderPrevious,
	readLastResult,
	writeInProgress,
} from '../integrations/auto-update/state.js'
import {
	type NpmUpgradeRequest,
	npmGlobalPrefixFor,
	removeOwnPowerShellShim,
	runNpmUpgrade,
} from '../integrations/npm-global.js'
import { resolveNamzuHome } from '../integrations/state/home.js'
import { type NamzuRelease, compareVersions, fetchNamzuRelease } from '../integrations/updates.js'
import type { CommandDef } from './types.js'
import { startUpgradeProgress } from './upgrade-progress.js'

const HELP = `namzu upgrade — update the active global Namzu installation

Usage:
  namzu upgrade
  namzu upgrade --check

Options:
  --check   Check the registry without changing the installation
  -h, --help  Show this help`

export { npmGlobalPrefixFor, removeOwnPowerShellShim, runNpmUpgrade }
export type { NpmUpgradeRequest }

export interface UpgradeCommandDeps {
	readonly currentVersion: string
	readonly packageRoot: string
	readonly platform: NodeJS.Platform
	/** What the registry says the channel points at, with the digest and address of its tarball. */
	readonly latestRelease: (channel: UpdateChannel) => Promise<NamzuRelease>
	/**
	 * Put the tarball at `file`, checked against the release's digest. Left out, it is
	 * downloaded from the registry the release came from.
	 */
	readonly fetchTarball?: (release: NamzuRelease, file: string) => Promise<void>
	readonly runNpm: (request: NpmUpgradeRequest) => Promise<number>
	readonly installedVersion: (packageRoot: string) => string
	/**
	 * After a verified update: ask a running scheduler to finish its runs and
	 * restart on the new code. Best effort; the scheduler also notices by itself.
	 */
	readonly afterUpgrade?: () => Promise<void>
	/**
	 * After a verified update on Windows: remove the `namzu.ps1` shim npm wrote
	 * into the global prefix. Defaults to {@link removeOwnPowerShellShim}.
	 */
	readonly removePowerShellShim?: (prefix: string) => void
	/**
	 * Keep the previous version and put it back when an update fails, and
	 * keep two updates from running at once. Left out, the command only
	 * installs and verifies.
	 */
	readonly safety?: {
		/** The Namzu home, where the lock and the kept copy live. */
		readonly home: string
		/** Start the new copy once; true when it answers with `version`. */
		readonly smokeTest: (
			root: string,
			version: string,
			depth?: 'version' | 'session',
		) => Promise<boolean>
	}
}

function scopeFor(
	platform: NodeJS.Platform,
	prefix: string | null,
	pnpmDir: string | null,
): string {
	return installScope(pnpmDir ?? prefix ?? '', platform)
}

function readInstalledVersion(packageRoot: string): string {
	const parsed = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
		name?: unknown
		version?: unknown
	}
	if (parsed.name !== '@namzu/cli') {
		throw new Error('the active package root is not @namzu/cli')
	}
	if (typeof parsed.version !== 'string') {
		throw new Error('the active @namzu/cli package has no readable version')
	}
	return parsed.version
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function safeHome(): string {
	try {
		return resolveNamzuHome()
	} catch {
		return join(PACKAGE_ROOT, '.namzu-updates')
	}
}

const productionDeps: UpgradeCommandDeps = {
	currentVersion: readInstalledVersion(PACKAGE_ROOT),
	packageRoot: PACKAGE_ROOT,
	platform: process.platform,
	latestRelease: (channel) => fetchNamzuRelease({ channel }),
	runNpm: runNpmUpgrade,
	installedVersion: readInstalledVersion,
	safety: { home: safeHome(), smokeTest: smokeTestInstalled },
	afterUpgrade: async () => {
		const [{ callEndpoint, readEndpoint }, { schedulePaths }, { resolveNamzuHome }] =
			await Promise.all([
				import('../schedule/daemon/endpoint.js'),
				import('../schedule/paths.js'),
				import('../integrations/state/home.js'),
			])
		const endpoint = readEndpoint(schedulePaths(resolveNamzuHome()).endpoint)
		if (endpoint) await callEndpoint(endpoint, 'drain-and-restart')
	},
}

function parseArgs(rawArgs: readonly string[]): { readonly check: boolean } | null {
	if (rawArgs.length === 0) return { check: false }
	if (rawArgs.length === 1 && rawArgs[0] === '--check') return { check: true }
	return null
}

export function createUpgradeCommand(deps: UpgradeCommandDeps): CommandDef {
	return {
		name: 'upgrade',
		description: 'Update the active global Namzu installation',
		passThrough: true,
		help: HELP,
		handler: async ({ ctx, rawArgs }) => {
			const flags = parseArgs(rawArgs)
			if (!flags) {
				ctx.formatter.error({ message: 'Usage: namzu upgrade [--check]' })
				return EXIT_USAGE
			}

			const policy = resolveUpdatePolicy({
				config: ctx.config.updates,
				env: process.env,
				interactive: true,
			})
			let release: NamzuRelease
			try {
				release = await deps.latestRelease(policy.channel)
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error)
				ctx.formatter.error({
					message:
						policy.channel === 'stable' && /HTTP 404/.test(text)
							? 'No stable release has been published yet, so there is nothing to follow. Set the channel to latest to follow new releases.'
							: `Could not check the latest Namzu version: ${text}`,
				})
				return EXIT_UNAVAILABLE
			}

			const latest = release.version
			if (compareVersions(latest, deps.currentVersion) <= 0) {
				ctx.formatter.print({
					current: deps.currentVersion,
					latest,
					upToDate: true,
					text: `Namzu ${deps.currentVersion} is up to date.`,
				})
				return EXIT_OK
			}

			if (flags.check) {
				const last = deps.safety ? readLastResult(deps.safety.home) : undefined
				ctx.formatter.print({
					current: deps.currentVersion,
					latest,
					upToDate: false,
					text: `Namzu ${latest} is available (current: ${deps.currentVersion}). Run \`namzu upgrade\` to install it.${
						last?.outcome === 'failed' && last.detail
							? `\nThe last automatic update did not finish: ${last.detail}${
									last.log ? `\nWhat the installer printed is in ${last.log}` : ''
								}`
							: ''
					}`,
				})
				return EXIT_OK
			}

			const pnpmDir = deps.platform === 'win32' ? null : pnpmGlobalDirFor(deps.packageRoot)
			const prefix = pnpmDir ? null : npmGlobalPrefixFor(deps.packageRoot, deps.platform)
			if (!prefix && !pnpmDir) {
				ctx.formatter.error({
					message:
						'This Namzu process is not running from a recognized npm-global or pnpm-global installation, so it will not update a different binary by guessing. Reinstall with the same package manager, or use the installer from https://github.com/cogitave/namzu/blob/main/docs/cli/installation.md.',
				})
				return EXIT_UNAVAILABLE
			}

			let lock: ReturnType<typeof acquireUpdateLock> | undefined
			try {
				lock = deps.safety
					? acquireUpdateLock({
							// Filed inside the install, so a process with another Namzu home meets the same lock.
							home: join(pnpmDir ?? prefix ?? '', '.namzu-update'),
							scope: scopeFor(deps.platform, prefix, pnpmDir),
						})
					: undefined
			} catch {
				ctx.formatter.error({
					message:
						'Could not prepare the folder Namzu keeps update files in, so nothing was changed.',
				})
				return EXIT_FAIL
			}
			if (lock === null) {
				ctx.formatter.error({
					message: 'Another Namzu update is already running. Try again in a moment.',
				})
				return EXIT_FAIL
			}
			try {
				return await installUpdate({ deps, ctx, release, prefix, pnpmDir })
			} finally {
				lock?.release()
			}
		},
	}
}

interface InstallInput {
	readonly deps: UpgradeCommandDeps
	readonly ctx: Parameters<CommandDef['handler']>[0]['ctx']
	readonly release: NamzuRelease
	readonly prefix: string | null
	readonly pnpmDir: string | null
}

/**
 * Fetch the release tarball and check it against the registry's digest, then
 * install that file. Nothing is touched before the file is known to be the one
 * the registry vouched for.
 */
async function installUpdate(input: InstallInput): Promise<number> {
	const { deps, ctx, release, prefix, pnpmDir } = input
	const scope = scopeFor(deps.platform, prefix, pnpmDir)
	const scratch = deps.safety ? undefined : mkdtempSync(join(tmpdir(), 'namzu-upgrade-'))
	const file = deps.safety
		? tarballPath(deps.safety.home, scope, release.version)
		: join(scratch ?? '', `namzu-cli-${release.version}.tgz`)
	if (deps.safety) pruneStaleDownloads(deps.safety.home, scope, file)
	try {
		await (deps.fetchTarball ?? fetchFromRegistry(PUBLIC_REGISTRY))(release, file)
	} catch (error) {
		rmSync(file, { force: true })
		if (scratch) rmSync(scratch, { recursive: true, force: true })
		const code = error instanceof DownloadError ? error.code : 'network'
		ctx.formatter.error({ message: `${describeFailure(code)} Nothing was changed.` })
		return EXIT_FAIL
	}
	try {
		return await installVerified({ ...input, tarball: file })
	} finally {
		rmSync(file, { force: true })
		if (scratch) rmSync(scratch, { recursive: true, force: true })
	}
}

async function installVerified({
	deps,
	ctx,
	release,
	prefix,
	pnpmDir,
	tarball,
}: InstallInput & { readonly tarball: string }): Promise<number> {
	const latest = release.version
	const executable = pnpmDir ? 'pnpm' : deps.platform === 'win32' ? 'npm.cmd' : 'npm'
	const cwd = pnpmDir ?? prefix ?? ''
	const activeRootPath = pnpmDir ? join(pnpmDir, 'node_modules', '@namzu', 'cli') : deps.packageRoot
	const request: NpmUpgradeRequest = {
		executable,
		prefix: cwd,
		args: pnpmDir
			? pnpmInstallArgs(latest, PUBLIC_REGISTRY, tarball)
			: npmInstallArgs(cwd, latest, PUBLIC_REGISTRY, tarball),
	}
	ctx.formatter.info(
		`Updating the active ${pnpmDir ? 'pnpm' : 'npm'} installation from ${deps.currentVersion} to ${latest}…`,
	)

	// The copy kept before the installer touches anything, so a failed update leaves a working Namzu.
	let backup: string | undefined
	if (deps.safety && prefix) {
		try {
			backup = backupPackage(
				deps.packageRoot,
				deps.safety.home,
				deps.currentVersion,
				scopeFor(deps.platform, prefix, pnpmDir),
			)
		} catch {
			ctx.formatter.error({
				message: 'Could not keep a copy of the current version, so nothing was changed.',
			})
			return EXIT_FAIL
		}
	}
	// Where the lock lives too: inside the install, so every Namzu home sees it.
	const shared = join(cwd, '.namzu-update')
	const scope = scopeFor(deps.platform, prefix, pnpmDir)
	// The same marker a background update leaves, so an interrupted run is repaired on the next start.
	const marking = deps.safety !== undefined
	if (marking) {
		try {
			writeInProgress(
				shared,
				{
					pid: process.pid,
					to: latest,
					from: deps.currentVersion,
					...(backup ? { backup } : {}),
					at: Date.now(),
				},
				scope,
			)
		} catch {
			// The update goes on without the marker; the lock still guards it.
		}
	}
	const pnpmRun = (args: readonly string[]): Promise<number> =>
		deps.runNpm({ executable: 'pnpm', prefix: cwd, args })
	const putBackOldVersion = async (): Promise<string> => {
		const lost =
			' The previous version could not be put back; reinstall Namzu if it does not start.'
		if (backup) {
			try {
				restorePackage(deps.packageRoot, backup)
				if (marking) clearInProgress(shared, scope)
				return ' The previous version was put back.'
			} catch {
				return lost
			}
		}
		if (pnpmDir && deps.safety) {
			try {
				// The store still holds it: offline first, then the registry, and it must start.
				const back =
					(await reinstallPnpm(pnpmRun, deps.currentVersion, PUBLIC_REGISTRY)) &&
					deps.installedVersion(activeRootPath) === deps.currentVersion &&
					(await deps.safety.smokeTest(activeRootPath, deps.currentVersion, 'version'))
				if (back) {
					clearInProgress(shared, scope)
					return ' The previous version was put back.'
				}
			} catch {
				// Fall through to the plain sentence.
			}
			return lost
		}
		return ''
	}

	const progress =
		ctx.formatter.name === 'text' && !['silent', 'error'].includes(ctx.logging?.level ?? 'info')
			? startUpgradeProgress()
			: undefined
	let output = ''
	const stop = () => {
		progress?.stop()
		if (output)
			process.stderr.write(
				`${Array.from(stripVTControlCharacters(output))
					.filter(
						(char) =>
							char === '\n' ||
							char === '\t' ||
							(char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
					)
					.join('')}\n`,
			)
	}
	const failWith = async (message: string): Promise<number> => {
		stop()
		const restored = await putBackOldVersion()
		ctx.formatter.error({ message: `${message}${restored}` })
		return EXIT_FAIL
	}
	try {
		let code: number
		try {
			code = await deps.runNpm(
				progress
					? {
							...request,
							onOutput: (text) => {
								output = (output + text).slice(-16_384)
							},
						}
					: request,
			)
		} catch (error) {
			return await failWith(
				`Could not start ${pnpmDir ? 'pnpm' : 'npm'}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
		if (code !== 0) {
			return await failWith(
				`${pnpmDir ? 'pnpm' : 'npm'} exited with status ${code}; Namzu was not verified.`,
			)
		}

		// A tarball path leaves a `file:` entry in pnpm's global manifest that points at a file
		// deleted afterwards; record the registry's name for the version instead.
		if (pnpmDir && !(await settlePnpmByName(pnpmRun, latest, PUBLIC_REGISTRY))) {
			return await failWith('pnpm could not record the new version; Namzu was not verified.')
		}

		let installed: string
		try {
			installed = deps.installedVersion(activeRootPath)
		} catch (error) {
			return await failWith(
				`${pnpmDir ? 'pnpm' : 'npm'} exited successfully, but the active installation could not be read back: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
		if (installed !== latest) {
			return await failWith(
				`${pnpmDir ? 'pnpm' : 'npm'} exited successfully, but the active installation still reports ${installed} instead of ${latest}. No update is being claimed.`,
			)
		}
		if (deps.safety && !(await deps.safety.smokeTest(activeRootPath, latest))) {
			return await failWith(`Namzu ${latest} was installed but did not start.`)
		}

		if (deps.platform === 'win32' && prefix) {
			try {
				;(deps.removePowerShellShim ?? removeOwnPowerShellShim)(prefix)
			} catch {
				// namzu.cmd still works; the update itself succeeded.
			}
		}

		progress?.stop(true)
		if (marking) clearInProgress(shared, scope)
		if (deps.safety)
			pruneOlderPrevious(deps.safety.home, 2, scopeFor(deps.platform, prefix, pnpmDir))
		ctx.formatter.print({
			previous: deps.currentVersion,
			current: installed,
			updated: true,
			text: `Updated Namzu ${deps.currentVersion} → ${installed}.`,
		})
		await deps.afterUpgrade?.().catch(() => undefined)
		return EXIT_OK
	} finally {
		progress?.stop()
	}
}

export const upgradeCommand: CommandDef = createUpgradeCommand(productionDeps)
