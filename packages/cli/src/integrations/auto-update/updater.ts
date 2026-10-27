/**
 * The background update loop of the terminal UI.
 *
 * Ten seconds after the process started it looks for a newer version, then
 * every thirty minutes while the terminal stays open. Two Namzu processes never
 * look more often than every five minutes between them (the last look and its
 * answer are kept on disk). It never blocks anything and reports at most one
 * event per outcome: an update was installed, or one is available and here is
 * the exact command.
 */

import { compareVersions } from '../updates.js'
import {
	type ApplyDeps,
	type FailureStatus,
	type Release,
	applyUpdate,
	describeFailure,
	repairInterruptedUpdate,
	manualUpdateCommand,
} from './apply.js'
import type { InstallKind } from './install-kind.js'
import type { UpdatePolicy } from './policy.js'
import { type CheckRecord, readCheck, writeCheck, writeLastResult } from './state.js'

export const FIRST_CHECK_AFTER_MS = 10_000
export const CHECK_EVERY_MS = 30 * 60_000
export const SHARED_THROTTLE_MS = 5 * 60_000
/** After this many failed installs in a row the loop stops trying until the next start. */
export const MAX_CONSECUTIVE_FAILURES = 3

export type UpdaterEvent =
	/** Installed; the next start uses it. */
	| { readonly type: 'installed'; readonly from: string; readonly to: string }
	/** A newer version exists and Namzu will not (or could not) install it. */
	| {
			readonly type: 'available'
			readonly latest: string
			/** What to run; null when there is nothing the person can run (unknown layout). */
			readonly command: string | null
			/** Set when an automatic install was attempted and failed. */
			readonly failure?: FailureStatus
	  }

export interface UpdaterDeps {
	readonly currentVersion: string
	readonly install: InstallKind
	readonly policy: UpdatePolicy
	readonly home: string
	readonly platform: NodeJS.Platform
	readonly fetchRelease: (channel: 'latest' | 'stable') => Promise<Release>
	readonly applyDeps: Omit<ApplyDeps, 'install' | 'home' | 'currentVersion' | 'platform'>
	readonly onEvent: (event: UpdaterEvent) => void
	readonly now?: () => number
	/** Milliseconds this process has been running. */
	readonly uptimeMs?: () => number
}

export interface Updater {
	start(): void
	stop(): void
	/** Check for and repair an update a previous process left unfinished (used by `start` and by tests). */
	repair(): Promise<void>
	/** Run one cycle now (used by `start` and by tests). */
	runCycle(): Promise<void>
}

/** Layouts that are never touched and never announced. */
function silentKind(kind: InstallKind['kind']): boolean {
	return kind === 'development' || kind === 'ephemeral' || kind === 'desktop'
}

export function createUpdater(deps: UpdaterDeps): Updater {
	const now = deps.now ?? Date.now
	let timer: ReturnType<typeof setTimeout> | undefined
	let stopped = false
	let started = false
	let running = false
	let installedThisSession = false
	let failures = 0
	let announced: string | undefined

	const emitAvailable = (latest: string, failure?: FailureStatus) => {
		if (announced === latest) return
		announced = latest
		deps.onEvent({
			type: 'available',
			latest,
			command: manualUpdateCommand(
				// A refused write means the plain command would be refused again.
				failure === 'no_permission' && 'writable' in deps.install
					? { ...deps.install, writable: false }
					: deps.install,
				latest,
				deps.platform,
			),
			...(failure ? { failure } : {}),
		})
	}

	async function learnRelease(): Promise<{ release: Release; fresh: boolean } | null> {
		const channel = deps.policy.channel
		const recorded = readCheck(deps.home)
		if (recorded && recorded.channel === channel && now() - recorded.at < SHARED_THROTTLE_MS) {
			return {
				release: {
					version: recorded.version,
					...(recorded.integrity ? { integrity: recorded.integrity } : {}),
				},
				fresh: false,
			}
		}
		try {
			const release = await deps.fetchRelease(channel)
			const record: CheckRecord = {
				at: now(),
				channel,
				version: release.version,
				...(release.integrity ? { integrity: release.integrity } : {}),
			}
			writeCheck(deps.home, record, deps.applyDeps.pid)
			return { release, fresh: true }
		} catch {
			return null
		}
	}

	async function runCycle(): Promise<void> {
		if (stopped || running || installedThisSession) return
		const { install, policy } = deps
		if (!policy.check || silentKind(install.kind)) return
		running = true
		try {
			const learned = await learnRelease()
			if (!learned || stopped) return
			const { release } = learned
			if (compareVersions(release.version, deps.currentVersion) <= 0) return

			if (install.kind !== 'npm-global' && install.kind !== 'pnpm-global') {
				emitAvailable(release.version)
				return
			}
			if (!policy.install || !install.writable || failures >= MAX_CONSECUTIVE_FAILURES) {
				emitAvailable(release.version)
				return
			}

			const result = await applyUpdate(
				{
					...deps.applyDeps,
					install,
					home: deps.home,
					currentVersion: deps.currentVersion,
					platform: deps.platform,
				},
				release,
			)
			if (stopped) return
			const stamp = new Date(now()).toISOString()
			const method = install.kind
			switch (result.status) {
				case 'locked':
					return
				case 'already':
					if (compareVersions(result.to, deps.currentVersion) > 0) {
						installedThisSession = true
						deps.onEvent({ type: 'installed', from: deps.currentVersion, to: result.to })
					}
					return
				case 'installed':
					failures = 0
					installedThisSession = true
					writeLastResult(deps.home, {
						at: stamp,
						outcome: 'installed',
						status: 'installed',
						method,
						from: result.from,
						to: result.to,
					})
					deps.onEvent({ type: 'installed', from: result.from, to: result.to })
					return
				case 'failed':
					failures = result.code === 'no_permission' ? MAX_CONSECUTIVE_FAILURES : failures + 1
					writeLastResult(deps.home, {
						at: stamp,
						outcome: 'failed',
						status: result.code,
						method,
						from: deps.currentVersion,
						to: release.version,
						detail: result.detail,
					})
					emitAvailable(release.version, result.code)
					return
			}
		} finally {
			running = false
		}
	}

	async function repair(): Promise<void> {
		const { install } = deps
		if (install.kind !== 'npm-global' && install.kind !== 'pnpm-global') return
		const result = await repairInterruptedUpdate({
			...deps.applyDeps,
			install,
			home: deps.home,
			platform: deps.platform,
		})
		if (result.status === 'none' || result.status === 'busy' || stopped) return
		const method = install.kind
		const stamp = new Date(now()).toISOString()
		if (result.status === 'completed') {
			writeLastResult(deps.home, {
				at: stamp,
				outcome: 'installed',
				status: 'installed',
				method,
				from: result.from,
				to: result.to,
			})
			if (compareVersions(result.to, deps.currentVersion) > 0) {
				installedThisSession = true
				deps.onEvent({ type: 'installed', from: deps.currentVersion, to: result.to })
			}
			return
		}
		writeLastResult(deps.home, {
			at: stamp,
			outcome: 'failed',
			status: 'verify_failed',
			method,
			from: result.from,
			to: result.to,
			detail:
				result.status === 'restored'
					? describeFailure('verify_failed')
					: 'An update was interrupted and the previous version could not be put back; reinstall Namzu if it does not start.',
		})
	}

	function schedule(delayMs: number): void {
		if (stopped) return
		timer = setTimeout(() => {
			void runCycle()
				.catch(() => undefined)
				.finally(() => schedule(CHECK_EVERY_MS))
		}, delayMs)
		timer.unref?.()
	}

	return {
		start() {
			if (started || stopped) return
			started = true
			void repair().catch(() => undefined)
			const uptime = deps.uptimeMs?.() ?? process.uptime() * 1000
			schedule(Math.max(0, FIRST_CHECK_AFTER_MS - uptime))
		},
		stop() {
			stopped = true
			if (timer) clearTimeout(timer)
			timer = undefined
		},
		repair,
		runCycle,
	}
}
