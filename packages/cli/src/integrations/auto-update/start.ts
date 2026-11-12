/**
 * Wires the updater to this process: where this copy lives, the Namzu home,
 * the registry and the real installers.
 */

import type { UpdatesConfig } from '../../config/schema.js'
import { removeOwnPowerShellShim, runNpmUpgrade } from '../npm-global.js'
import { fetchNamzuRelease } from '../updates.js'
import { type InstallerRequest, PUBLIC_REGISTRY } from './apply.js'
import { currentInstall } from './current-install.js'
import { noteUpdatePending } from './deferred-apply.js'
import { readInstalledVersion } from './installed-version.js'
import { type UpdatePolicy, resolveUpdatePolicy } from './policy.js'
import { type Updater, type UpdaterEvent, createUpdater } from './updater.js'

export interface StartAutoUpdateOptions {
	readonly currentVersion: string
	readonly config?: UpdatesConfig | undefined
	readonly onEvent: (event: UpdaterEvent) => void
	readonly env?: NodeJS.ProcessEnv
}

export { currentInstall }

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
		// This process runs from the folder an install replaces: it never installs, the process that
		// outlives it does once nothing runs from the install (`apply-at-exit.ts`).
		applyMode: 'defer',
		onPending: () => noteUpdatePending(policy.channel),
	})
	updater.start()
	return { stop: () => updater.stop(), policy }
}
