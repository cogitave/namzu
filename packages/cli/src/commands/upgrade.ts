import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, posix, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EXIT_FAIL, EXIT_OK, EXIT_UNAVAILABLE, EXIT_USAGE } from '../exit-codes.js'
import { compareVersions, latestNamzuVersion } from '../integrations/updates.js'
import type { CommandDef } from './types.js'

const HELP = `namzu upgrade — update the active global Namzu installation

Usage:
  namzu upgrade
  namzu upgrade --check

Options:
  --check   Check the registry without changing the installation
  -h, --help  Show this help`

export interface NpmUpgradeRequest {
	readonly executable: string
	readonly args: readonly string[]
	readonly prefix: string
}

export interface UpgradeCommandDeps {
	readonly currentVersion: string
	readonly packageRoot: string
	readonly platform: NodeJS.Platform
	readonly latestVersion: () => Promise<string>
	readonly runNpm: (request: NpmUpgradeRequest) => Promise<number>
	readonly installedVersion: (packageRoot: string) => string
}

/**
 * Derive the prefix owning an npm-global @namzu/cli package.
 *
 * The executing package root is authority. Ambient `npm prefix -g` may point
 * at a different Node installation, especially under version managers, so it
 * is deliberately not consulted.
 */
export function npmGlobalPrefixFor(packageRoot: string, platform: NodeJS.Platform): string | null {
	const paths = platform === 'win32' ? win32 : posix
	const root = paths.resolve(packageRoot)
	const expectedTail =
		platform === 'win32'
			? paths.join('node_modules', '@namzu', 'cli')
			: paths.join('lib', 'node_modules', '@namzu', 'cli')
	const comparableRoot = platform === 'win32' ? root.toLowerCase() : root
	const comparableTail = platform === 'win32' ? expectedTail.toLowerCase() : expectedTail
	const suffix = `${paths.sep}${comparableTail}`
	if (!comparableRoot.endsWith(suffix)) return null
	const prefix = root.slice(0, root.length - suffix.length)
	return prefix.length > 0 ? prefix : paths.parse(root).root
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

function runNpm(request: NpmUpgradeRequest): Promise<number> {
	return new Promise((resolveRun, reject) => {
		const child = spawn(request.executable, [...request.args], {
			cwd: request.prefix,
			env: process.env,
			stdio: 'inherit',
			shell: false,
		})
		child.once('error', reject)
		child.once('exit', (code) => resolveRun(code ?? 1))
	})
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const productionDeps: UpgradeCommandDeps = {
	currentVersion: readInstalledVersion(PACKAGE_ROOT),
	packageRoot: PACKAGE_ROOT,
	platform: process.platform,
	latestVersion: latestNamzuVersion,
	runNpm,
	installedVersion: readInstalledVersion,
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

			let latest: string
			try {
				latest = await deps.latestVersion()
			} catch (error) {
				ctx.formatter.error({
					message: `Could not check the latest Namzu version: ${error instanceof Error ? error.message : String(error)}`,
				})
				return EXIT_UNAVAILABLE
			}

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
				ctx.formatter.print({
					current: deps.currentVersion,
					latest,
					upToDate: false,
					text: `Namzu ${latest} is available (current: ${deps.currentVersion}). Run \`namzu upgrade\` to install it.`,
				})
				return EXIT_OK
			}

			const prefix = npmGlobalPrefixFor(deps.packageRoot, deps.platform)
			if (!prefix) {
				ctx.formatter.error({
					message:
						'This Namzu process is not running from a recognized npm-global installation, so it will not update a different binary by guessing. Reinstall with the same package manager, or use the installer from https://github.com/cogitave/namzu#the-terminal-agent.',
				})
				return EXIT_UNAVAILABLE
			}

			const executable = deps.platform === 'win32' ? 'npm.cmd' : 'npm'
			const request: NpmUpgradeRequest = {
				executable,
				prefix,
				args: [
					'install',
					'--global',
					'--prefix',
					prefix,
					'--no-fund',
					'--no-audit',
					'--registry',
					'https://registry.npmjs.org',
					`@namzu/cli@${latest}`,
				],
			}
			ctx.formatter.info(
				`Updating the active npm installation from ${deps.currentVersion} to ${latest}…`,
			)

			let code: number
			try {
				code = await deps.runNpm(request)
			} catch (error) {
				ctx.formatter.error({
					message: `Could not start npm: ${error instanceof Error ? error.message : String(error)}`,
				})
				return EXIT_FAIL
			}
			if (code !== 0) {
				ctx.formatter.error({
					message: `npm exited with status ${code}; Namzu was not verified.`,
				})
				return EXIT_FAIL
			}

			let installed: string
			try {
				installed = deps.installedVersion(deps.packageRoot)
			} catch (error) {
				ctx.formatter.error({
					message: `npm exited successfully, but the active installation could not be read back: ${error instanceof Error ? error.message : String(error)}`,
				})
				return EXIT_FAIL
			}
			if (installed !== latest) {
				ctx.formatter.error({
					message: `npm exited successfully, but the active installation still reports ${installed} instead of ${latest}. No update is being claimed.`,
				})
				return EXIT_FAIL
			}

			ctx.formatter.print({
				previous: deps.currentVersion,
				current: installed,
				updated: true,
				text: `Updated Namzu ${deps.currentVersion} → ${installed}.`,
			})
			return EXIT_OK
		},
	}
}

export const upgradeCommand: CommandDef = createUpgradeCommand(productionDeps)
