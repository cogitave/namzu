/**
 * The detached process a session leaves behind when it ends with an update due: it waits
 * until no Namzu process runs from the install, then runs the same update the loop would have
 * (checked download, kept copy, install, start check, roll back on failure). It is started
 * with `namzu --apply-at-exit` and prints nothing; the outcome is kept in the update files, as for
 * any automatic update.
 *
 * It runs from the folder it replaces, so everything it needs is imported statically by this
 * module and loaded before the first file changes.
 */

import { CLI_VERSION } from '../../version.js'
import { removeOwnPowerShellShim, runNpmUpgrade } from '../npm-global.js'
import { fetchNamzuRelease } from '../updates.js'
import { scopeOf, sharedStateHome } from './apply.js'
import { type InstallerRequest, PUBLIC_REGISTRY } from './apply.js'
import { currentInstall } from './current-install.js'
import type { InstallKind } from './install-kind.js'
import { readInstalledVersion } from './installed-version.js'
import { resolveUpdatePolicy } from './policy.js'
import { otherRunning } from './running.js'
import { acquireUpdateLock } from './state.js'
import { type UpdaterEvent, createUpdater } from './updater.js'

/** How often the waiting installer looks whether the install is still in use. */
export const WAIT_POLL_MS = 15_000
/** How long it waits at most. A session left open for longer gets the update at its next end. */
export const WAIT_LIMIT_MS = 6 * 60 * 60_000

type Updatable = Extract<InstallKind, { kind: 'npm-global' | 'pnpm-global' }>

export interface WaitThenApplyDeps {
	readonly install: Updatable
	readonly platform: NodeJS.Platform
	readonly home: string
	/** Process ids running from the install now. */
	readonly others: () => number[]
	/** Run one update cycle; resolves with what it reported. */
	readonly cycle: () => Promise<readonly UpdaterEvent[]>
	readonly sleep: (ms: number) => Promise<void>
	readonly now: () => number
	readonly pid?: number
	readonly isAlive?: (pid: number) => boolean
	readonly pollMs?: number
	readonly limitMs?: number
}

export type WaitOutcome = 'done' | 'another-waits' | 'gave-up'

/** Wait for the install to be free, then run one cycle; look again when something started meanwhile. */
export async function waitThenApply(deps: WaitThenApplyDeps): Promise<WaitOutcome> {
	const limit = deps.limitMs ?? WAIT_LIMIT_MS
	const lock = acquireUpdateLock({
		home: sharedStateHome(deps.install),
		scope: `${scopeOf(deps.install, deps.platform)}-exit`,
		...(deps.pid !== undefined ? { pid: deps.pid } : {}),
		now: deps.now,
		...(deps.isAlive ? { isAlive: deps.isAlive } : {}),
		staleMs: limit,
	})
	// One waiting installer per install is enough: it installs for everyone.
	if (!lock) return 'another-waits'
	try {
		const until = deps.now() + limit
		while (deps.now() < until) {
			if (deps.others().length === 0) {
				const events = await deps.cycle()
				// `idle` is "a window started, or another installer holds the lock": not done yet.
				if (!events.some((event) => event.type === 'idle')) return 'done'
			}
			await deps.sleep(deps.pollMs ?? WAIT_POLL_MS)
		}
		return 'gave-up'
	} finally {
		lock.release()
	}
}

/** The entry of `namzu --apply-at-exit`. */
export async function runApplyAtExit(
	env: NodeJS.ProcessEnv = process.env,
): Promise<WaitOutcome | 'not-applicable'> {
	const found = currentInstall(env)
	if (!found) return 'not-applicable'
	const { install, home } = found
	if ((install.kind !== 'npm-global' && install.kind !== 'pnpm-global') || !install.writable) {
		return 'not-applicable'
	}
	const policy = resolveUpdatePolicy({ config: undefined, env, interactive: true })
	if (!policy.check || !policy.install) return 'not-applicable'
	const cycle = async (): Promise<readonly UpdaterEvent[]> => {
		const events: UpdaterEvent[] = []
		const updater = createUpdater({
			currentVersion: CLI_VERSION,
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
				mayProceed: () => otherRunning(install, { except: process.pid }).length === 0,
			},
			onEvent: (event) => events.push(event),
			applyMode: 'now',
		})
		await updater.runCycle()
		return events
	}
	return waitThenApply({
		install,
		platform: process.platform,
		home,
		others: () => otherRunning(install, { except: process.pid }),
		cycle,
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		now: Date.now,
	})
}
