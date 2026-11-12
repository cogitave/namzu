import { join } from 'node:path'
import type {
	EngineDeliveryView,
	EngineRun,
	EngineVersions,
} from '../../shared/engine-delivery-protocol.js'
import type { HostLauncher, HostRun, SpawnSpec } from '../host-launcher.js'
import { type CheckDeps, type CheckResult, runCheck, singleFlight } from './check.js'
import { type KernelManager, type ResolvedKernel, startWithFallback } from './manager.js'
import { versionFolder } from './state.js'
import type { KernelLog } from './store.js'
import { buildEngineView } from './view.js'

/**
 * The engine delivery as the app runs it: the schedule of checks, the choice of engine at every
 * start, and the view the screens draw. Every effect (time, network, processes, windows) is passed
 * in; this file holds no timer and opens no socket of its own.
 */

export const FIRST_CHECK_DELAY_MS = 30_000
export const CHECK_INTERVAL_MS = 4 * 60 * 60_000

export interface DeliveryClock {
	now(): number
	/** Runs once, unless the returned function is called first. */
	after(ms: number, run: () => void): () => void
	/** Repeats until the returned function is called. */
	every(ms: number, run: () => void): () => void
}

export interface DeliveryDeps {
	manager: KernelManager
	/** Settles when the engine folder's state has been read; nothing runs before it. */
	ready: Promise<void>
	channel: string
	feedBase: string
	fetch: CheckDeps['fetch']
	selfCheck: CheckDeps['selfCheck']
	clock: DeliveryClock
	firstCheckDelayMs?: number
	intervalMs?: number
	/** The versions of the engine inside the installer, read from its own files. */
	bundledVersions: () => EngineVersions
	/** The versions of the engine at an entry path, read from its own files. */
	versionsOf: (entry: string) => EngineVersions
	/** Turns a spawn on an engine into the program, arguments and environment to start. */
	spec: (entry: string) => SpawnSpec
	/** A new view of the engine: draw it. */
	publish: (view: EngineDeliveryView) => void
	log: KernelLog
	/** Resolves when every line logged so far has reached the file (for tests and quitting). */
	flushLog?: () => Promise<void>
}

export class EngineDelivery {
	private started?: { entry: string; run: EngineRun }
	private checking = false
	/** Stops the check that runs now, when the setting is turned off or the app quits. */
	private abort: AbortController | undefined
	private inflight: Promise<CheckResult> | undefined
	private cancel: (() => void)[] = []
	private readonly flight: () => Promise<CheckResult>
	private versions = new Map<string, EngineVersions>()

	constructor(private readonly deps: DeliveryDeps) {
		this.flight = singleFlight(() => this.runOnce())
		void deps.ready.then(() => this.publish())
	}

	flushLog(): Promise<void> {
		return this.deps.flushLog?.() ?? Promise.resolve()
	}

	/** Settles when the engine folder's state has been read. */
	get ready(): Promise<void> {
		return this.deps.ready
	}

	/** The feature may act: a key is built in and the setting is on. */
	get active(): boolean {
		return this.manager.active
	}

	private get manager(): KernelManager {
		return this.deps.manager
	}

	/** First check shortly after launch, then on a fixed interval. */
	start(): void {
		if (this.cancel.length > 0) return
		const run = () => void this.check().catch(() => undefined)
		this.cancel.push(
			this.deps.clock.after(this.deps.firstCheckDelayMs ?? FIRST_CHECK_DELAY_MS, run),
			this.deps.clock.every(this.deps.intervalMs ?? CHECK_INTERVAL_MS, run),
		)
	}

	/** Stops the schedule and any check that runs. The log is flushed with `flushLog`. */
	stop(): void {
		for (const cancel of this.cancel) cancel()
		this.cancel = []
		this.abort?.abort()
	}

	/** One check at a time; a call while one runs gets that one's answer. */
	check(): Promise<CheckResult> {
		const run = this.flight()
		this.inflight = run
		void run.then(
			() => this.clearInflight(run),
			() => this.clearInflight(run),
		)
		return run
	}

	private clearInflight(run: Promise<CheckResult>): void {
		if (this.inflight === run) this.inflight = undefined
	}

	/**
	 * For quitting: stops the schedule and the check that runs, waits for that check to end
	 * (it ends at its next step once stopped) and for the log to reach the file.
	 */
	async stopAndFlush(): Promise<void> {
		this.stop()
		await this.inflight?.catch(() => undefined)
		await this.flushLog().catch(() => undefined)
	}

	private async runOnce(): Promise<CheckResult> {
		await this.deps.ready
		const wasSkippable = !this.manager.active || Boolean(this.manager.options.override())
		if (!wasSkippable) {
			this.checking = true
			this.publish()
		}
		const controller = new AbortController()
		this.abort = controller
		try {
			return await runCheck({
				signal: controller.signal,
				manager: this.manager,
				feedBase: this.deps.feedBase,
				channel: this.deps.channel,
				fetch: this.deps.fetch,
				now: this.deps.clock.now,
				selfCheck: this.deps.selfCheck,
			})
		} finally {
			if (this.abort === controller) this.abort = undefined
			this.checking = false
			this.publish()
		}
	}

	/** The setting changed: draw it, and look for an engine soon when it was turned on. */
	settingChanged(): void {
		// Turned off: a check that runs now must not go on to download, unpack or make anything pending.
		if (!this.manager.options.enabled()) this.abort?.abort()
		this.publish()
		if (this.manager.active)
			this.deps.clock.after(0, () => void this.check().catch(() => undefined))
	}

	/** "Use this app's own engine". Takes effect at the next start of a host. */
	async useOwnEngine(): Promise<void> {
		await this.manager.useOwnEngine()
		this.publish()
	}

	private versionsOf(entry: string): EngineVersions {
		let known = this.versions.get(entry)
		if (!known) {
			known = this.deps.versionsOf(entry)
			this.versions.set(entry, known)
		}
		return known
	}

	/** What runs: the last host started, or what the next start would use when none has. */
	running(): EngineRun {
		if (this.started) return this.started.run
		const override = this.manager.options.override()
		if (override) return { source: 'override', ...this.versionsOf(override) }
		const state = this.manager.store.snapshot()
		if (this.manager.active && state.current && !state.bad[state.current]) {
			const { engine } = this.versionsOf(this.managedEntry(state.current))
			return {
				source: 'managed',
				commandLine: state.current,
				...(engine ? { engine } : {}),
				...(state.updatedAt !== undefined ? { since: state.updatedAt } : {}),
			}
		}
		return { source: 'bundled', ...this.deps.bundledVersions() }
	}

	private managedEntry(version: string): string {
		return join(versionFolder(this.manager.store.paths, version), 'dist', 'bin.js')
	}

	view(): EngineDeliveryView {
		const options = this.manager.options
		return buildEngineView({
			available: true,
			enabled: options.enabled(),
			override: Boolean(options.override()),
			state: this.manager.store.snapshot(),
			running: this.running(),
			bundled: this.deps.bundledVersions(),
			checking: this.checking,
			now: this.deps.clock.now(),
		})
	}

	publish(): void {
		try {
			this.deps.publish(this.view())
		} catch {
			// a window that cannot be told is not the engine's concern
		}
	}

	private runOf(kernel: ResolvedKernel): EngineRun {
		if (kernel.source === 'managed')
			return {
				source: 'managed',
				...(kernel.version ? { commandLine: kernel.version } : {}),
				...(kernel.engine ? { engine: kernel.engine } : {}),
				...(kernel.updatedAt !== undefined ? { since: kernel.updatedAt } : {}),
			}
		if (kernel.source === 'override')
			return { source: 'override', ...this.versionsOf(kernel.entry) }
		return { source: 'bundled', ...this.deps.bundledVersions() }
	}

	/**
	 * The launcher a connection to a host starts through (sections 5.3 and 5.4): the engine is
	 * chosen now, a fetched one that fails is given up, and the start is tried once more.
	 */
	launcher(): HostLauncher {
		return {
			start: async (attempt, isFault) => {
				await this.deps.ready
				const { kernel, retried, release } = await startWithFallback(
					this.manager,
					async (resolved) => {
						await attempt(this.deps.spec(resolved.entry), {
							retryable: resolved.source === 'managed',
						})
					},
					{ isKernelFault: isFault },
				)
				if (retried)
					this.deps.log('start-retried', {
						version: kernel.wentBack?.[0]?.version,
						reason: kernel.wentBack?.[0]?.reason,
					})
				let token: Awaited<ReturnType<KernelManager['hostStarted']>>
				try {
					token = await this.manager.hostStarted(kernel)
				} finally {
					release()
				}
				this.started = { entry: kernel.entry, run: this.runOf(kernel) }
				this.publish()
				const run: HostRun = {
					exited: (unexpected) => {
						void this.manager
							.hostExited(token, { unexpected })
							.then((gaveUp) => {
								if (gaveUp) this.publish()
								return this.manager.cleanup()
							})
							.catch(() => undefined)
					},
				}
				return run
			},
		}
	}

	/**
	 * A process that is not a host (a terminal tab, a short command) runs on the engine chosen now.
	 * Call `release` when it ends; until then the engine's folder is not removed.
	 */
	async lease(): Promise<{ entry: string; release: () => void }> {
		await this.deps.ready
		const kernel = await this.manager.resolve({ hold: true })
		const release = kernel.release ?? (() => undefined)
		return {
			entry: kernel.entry,
			release: () => {
				release()
				void this.manager.cleanup().catch(() => undefined)
			},
		}
	}
}
