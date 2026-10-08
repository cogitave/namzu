import {
	type UpdateBlocker,
	type UpdateInstallResult,
	type UpdateState,
	type UpdateUiBusy,
	isUpdateUiBusy,
} from '../shared/update-protocol.js'

/** The slice of electron-updater's `AppUpdater` this controller drives. */
export interface AutoUpdaterLike {
	autoDownload: boolean
	autoInstallOnAppQuit: boolean
	allowDowngrade: boolean
	forceDevUpdateConfig?: boolean
	on(event: string, listener: (...args: unknown[]) => void): unknown
	setFeedURL(options: UpdateFeed): void
	checkForUpdates(): Promise<unknown>
	quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export type UpdateFeed =
	| { provider: 'generic'; url: string }
	| { provider: 'github'; owner: string; repo: string }

export const firstCheckDelayMs = 30_000
export const checkIntervalMs = 4 * 60 * 60_000
export const idleRetryMs = 3_000

/**
 * The feed comes from the environment until publishing is approved. A generic HTTP(S) URL is
 * the only source used by default; the GitHub provider is read only when asked for by name.
 */
export function updateFeedFromEnv(
	env: Record<string, string | undefined>,
	options: { packaged?: boolean } = {},
): UpdateFeed | undefined {
	if (env.NAMZU_UPDATE_PROVIDER === 'github') {
		const [owner, repo] = (env.NAMZU_UPDATE_GITHUB ?? '').split('/')
		if (!owner || !repo) return undefined
		// An installed app only ever updates from its own repository.
		if (options.packaged && `${owner}/${repo}`.toLowerCase() !== 'cogitave/namzu') return undefined
		return { provider: 'github', owner, repo }
	}
	const raw = env.NAMZU_UPDATE_FEED_URL
	if (!raw) return undefined
	try {
		const url = new URL(raw)
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
		// Updates are integrity-checked only, so an installed app takes a feed from its environment
		// solely on this machine (the clean-machine test serves one on loopback).
		if (options.packaged && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
			return undefined
		return { provider: 'generic', url: url.href }
	} catch {
		return undefined
	}
}

/**
 * True when the build's own `app-update.yml` names a provider. The installer writes that file with
 * only a cache folder name until publishing is approved, so such a build checks nothing by itself.
 */
export function bakedFeedDeclared(appUpdateYml: string | undefined): boolean {
	return appUpdateYml !== undefined && /^provider:\s*\S/m.test(appUpdateYml)
}

/** Merges what each window reported; one busy window blocks the restart. */
export function uiBlockers(reports: Iterable<UpdateUiBusy>): UpdateBlocker[] {
	const found = new Set<UpdateBlocker>()
	for (const report of reports) {
		if (report.dialogOpen) found.add('dialog-open')
		if (report.typingRecent) found.add('typing-unsaved')
		if (report.computerSession) found.add('computer-session')
	}
	return [...found]
}

export interface UpdateControllerOptions {
	/** Read lazily: electron-updater is touched only when updates are enabled. */
	updater: () => AutoUpdaterLike
	/** False in an unpackaged app that has no feed: nothing is checked and nothing is shown. */
	enabled: boolean
	feed?: UpdateFeed
	/** Facts the main process owns: turns, permissions, background work. */
	mainBlockers: () => UpdateBlocker[]
	/** Our own graceful shutdown. It runs completely before the installer starts. */
	shutdown: () => Promise<void>
	/** Starts the app again when the installer could not begin after the runtime was stopped. */
	relaunch: () => void
	broadcast: (state: UpdateState) => void
	record: (event: string, details?: Record<string, unknown>) => void
}

/**
 * The update state machine. It never installs while work is active, stops the runtime itself
 * before handing control to the installer, and treats every error as quiet.
 */
export class UpdateController {
	private current: UpdateState
	private readonly reports = new Map<string, UpdateUiBusy>()
	private firstCheck?: ReturnType<typeof setTimeout>
	private interval?: ReturnType<typeof setInterval>
	private idleTimer?: ReturnType<typeof setTimeout>
	private installing = false
	private started = false

	constructor(private readonly options: UpdateControllerOptions) {
		this.current = { status: options.enabled ? 'idle' : 'disabled' }
	}

	get state(): UpdateState {
		return this.current
	}

	/** Wires electron-updater and schedules the first check and the periodic ones. */
	start(): void {
		if (this.started || !this.options.enabled) return
		this.started = true
		const { feed } = this.options
		const updater = this.options.updater()
		updater.autoDownload = true
		updater.autoInstallOnAppQuit = false
		updater.allowDowngrade = false
		if (feed) {
			// Needed for an unpackaged run; a packaged one ignores it.
			updater.forceDevUpdateConfig = true
			updater.setFeedURL(feed)
		}
		updater.on('checking-for-update', () => {
			if (this.current.status === 'idle' || this.current.status === 'error')
				this.set({ status: 'checking' })
		})
		updater.on('update-available', () => {
			if (this.current.status === 'checking' || this.current.status === 'idle')
				this.set({ status: 'downloading', percent: 0, bytesPerSecond: 0 })
		})
		updater.on('update-not-available', () => {
			if (this.current.status === 'checking') this.set({ status: 'idle' })
		})
		updater.on('download-progress', ((progress: { percent?: number; bytesPerSecond?: number }) => {
			if (this.current.status !== 'downloading' && this.current.status !== 'checking') return
			this.set({
				status: 'downloading',
				percent: clampPercent(progress.percent),
				bytesPerSecond: Math.max(0, clampNumber(progress.bytesPerSecond)),
			})
		}) as never)
		updater.on('update-downloaded', ((info: { version?: string }) => {
			if (this.current.status === 'installing') return
			this.set({ status: 'ready', version: info.version ?? 'new' })
		}) as never)
		updater.on('error', ((error: unknown) => this.failed(error)) as never)
		this.firstCheck = setTimeout(() => void this.check(), firstCheckDelayMs)
		this.firstCheck.unref?.()
		this.interval = setInterval(() => void this.check(), checkIntervalMs)
		this.interval.unref?.()
	}

	/** Manual or scheduled check. Skipped while a download or install owns the updater. */
	async check(): Promise<void> {
		if (!this.options.enabled) return
		const status = this.current.status
		if (status === 'checking' || status === 'downloading' || status === 'installing') return
		if (status === 'ready') return
		try {
			await this.options.updater().checkForUpdates()
		} catch (error) {
			this.failed(error)
		}
	}

	/** The renderer's own facts for one window; the latest report replaces the last. */
	report(windowId: string, busy: unknown): void {
		if (!isUpdateUiBusy(busy)) return
		this.reports.set(windowId, busy)
	}

	forgetWindow(windowId: string): void {
		this.reports.delete(windowId)
	}

	/** Drops reports of windows that are gone. */
	retainWindows(ids: Iterable<string>): void {
		const live = new Set(ids)
		for (const id of [...this.reports.keys()]) if (!live.has(id)) this.reports.delete(id)
	}

	blockers(): UpdateBlocker[] {
		return [...new Set([...this.options.mainBlockers(), ...uiBlockers(this.reports.values())])]
	}

	/**
	 * Restart now. A blocked request is remembered and retried at idle moments until Later;
	 * nothing installs unless this was called.
	 */
	async install(): Promise<UpdateInstallResult> {
		const state = this.current
		if (state.status !== 'ready') return { ok: false, error: 'No update is ready to install.' }
		const blockers = this.blockers()
		if (blockers.length) {
			this.set({ status: 'ready', version: state.version, waiting: blockers })
			this.scheduleIdleCheck()
			return { ok: false, blockers }
		}
		return this.perform(state.version)
	}

	/** Later: forget a blocked restart. The update stays ready. */
	cancel(): void {
		this.clearIdleTimer()
		const state = this.current
		if (state.status === 'ready' && (state.waiting || state.error))
			this.set({ status: 'ready', version: state.version })
	}

	dispose(): void {
		clearTimeout(this.firstCheck)
		clearInterval(this.interval)
		this.clearIdleTimer()
	}

	private scheduleIdleCheck(): void {
		this.clearIdleTimer()
		this.idleTimer = setTimeout(() => {
			this.idleTimer = undefined
			const state = this.current
			if (state.status !== 'ready' || !state.waiting) return
			const blockers = this.blockers()
			if (blockers.length) {
				if (!sameBlockers(blockers, state.waiting))
					this.set({ status: 'ready', version: state.version, waiting: blockers })
				this.scheduleIdleCheck()
				return
			}
			void this.perform(state.version)
		}, idleRetryMs)
		this.idleTimer.unref?.()
	}

	private clearIdleTimer(): void {
		clearTimeout(this.idleTimer)
		this.idleTimer = undefined
	}

	private async perform(version: string): Promise<UpdateInstallResult> {
		if (this.installing) return { ok: true }
		this.installing = true
		this.clearIdleTimer()
		this.set({ status: 'installing', version, phase: 'preparing' })
		try {
			await this.options.shutdown()
		} catch (error) {
			// The runtime may be half stopped; the installer must not run over it.
			this.installing = false
			this.options.record('update_failed', { stage: 'shutdown', error })
			this.set({
				status: 'ready',
				version,
				error: 'Namzu could not stop its work cleanly, so the update was not installed.',
			})
			return { ok: false, error: 'Shutdown failed.' }
		}
		this.set({ status: 'installing', version, phase: 'installing' })
		try {
			this.options.updater().quitAndInstall(true, true)
		} catch (error) {
			this.installerFailed(error)
			return { ok: false, error: 'The installer could not start.' }
		}
		return { ok: true }
	}

	/** After our shutdown the runtime is gone, so a refused installer means starting again. */
	private installerFailed(error: unknown): void {
		this.installing = false
		this.options.record('update_failed', { stage: 'install', error })
		this.options.relaunch()
	}

	private failed(error: unknown): void {
		const status = this.current.status
		if (status === 'installing') {
			this.installerFailed(error)
			return
		}
		this.options.record('update_failed', { stage: status, error })
		// A downloaded update stays installable; only a check or download is reported quietly.
		if (status === 'ready') return
		this.set({ status: 'error', message: 'Update check failed.' })
	}

	private set(state: UpdateState): void {
		this.current = state
		this.options.broadcast(state)
	}
}

function clampNumber(value: number | undefined): number {
	return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0
}

function clampPercent(value: number | undefined): number {
	return Math.min(100, Math.max(0, clampNumber(value)))
}

function sameBlockers(a: UpdateBlocker[], b: UpdateBlocker[]): boolean {
	return a.length === b.length && a.every((item) => b.includes(item))
}
