/**
 * Wires the updater to this process: where this copy lives, the Namzu home,
 * the registry and the real installers.
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { UpdatesConfig } from '../../config/schema.js'
import { removeOwnPowerShellShim, runNpmUpgrade } from '../npm-global.js'
import { resolveNamzuHome } from '../state/home.js'
import { fetchNamzuRelease } from '../updates.js'
import { type InstallerRequest, PUBLIC_REGISTRY } from './apply.js'
import { type InstallKind, classifyInstall, realRoot } from './install-kind.js'
import { readInstalledVersion } from './installed-version.js'
import { type UpdatePolicy, resolveUpdatePolicy } from './policy.js'
import { type Updater, type UpdaterEvent, createUpdater } from './updater.js'

export interface StartAutoUpdateOptions {
	readonly currentVersion: string
	readonly config?: UpdatesConfig | undefined
	readonly onEvent: (event: UpdaterEvent) => void
	readonly env?: NodeJS.ProcessEnv
}

const PACKAGE_ROOT = realRoot(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'))

/** Where this copy lives and which Namzu home its update files are in; null without a home. */
export function currentInstall(
	env: NodeJS.ProcessEnv = process.env,
): { readonly install: InstallKind; readonly home: string } | null {
	let home: string
	try {
		home = resolveNamzuHome({ env })
	} catch {
		return null
	}
	const install = classifyInstall({
		packageRoot: PACKAGE_ROOT,
		platform: process.platform,
		namzuHome: home,
		env,
		isElectron: process.versions.electron !== undefined,
	})
	return { install, home }
}

/** Start the loop; returns its stop function. The terminal UI is the one caller. */
export function startAutoUpdate(options: StartAutoUpdateOptions): {
	stop(): void
	policy: UpdatePolicy
} {
	const env = options.env ?? process.env
	const policy = resolveUpdatePolicy({ config: options.config, env, interactive: true })
	const noop = { stop() {}, policy }
	if (!policy.check) return noop
	const found = currentInstall(env)
	if (!found) return noop
	const { home, install } = found
	const updater: Updater = createUpdater({
		currentVersion: options.currentVersion,
		install,
		policy,
		home,
		platform: process.platform,
		fetchRelease: (channel) => fetchNamzuRelease({ channel, registry: PUBLIC_REGISTRY }),
		applyDeps: {
			runInstaller: (request: InstallerRequest) =>
				runNpmUpgrade({
					executable: request.executable,
					args: request.args,
					prefix: request.cwd,
					onOutput: request.onOutput,
					...(request.logFile ? { logFile: request.logFile } : {}),
					background: true,
					timeoutMs: request.timeoutMs,
					...(request.onSpawn ? { onSpawn: request.onSpawn } : {}),
				}),
			installedVersion: readInstalledVersion,
			removePowerShellShim: removeOwnPowerShellShim,
		},
		onEvent: options.onEvent,
	})
	updater.start()
	return { stop: () => updater.stop(), policy }
}
