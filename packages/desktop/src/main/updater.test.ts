import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateBlocker, UpdateState } from '../shared/update-protocol.js'
import {
	type AutoUpdaterLike,
	UpdateController,
	type UpdateFeed,
	bakedFeedDeclared,
	checkIntervalMs,
	firstCheckDelayMs,
	idleRetryMs,
	uiBlockers,
	updateFeedFromEnv,
} from './updater.js'

class FakeUpdater extends EventEmitter implements AutoUpdaterLike {
	autoDownload = false
	autoInstallOnAppQuit = true
	allowDowngrade = true
	forceDevUpdateConfig = false
	feed?: UpdateFeed
	checks = 0
	calls: string[] = []
	checkResult: () => Promise<unknown> = async () => undefined
	setFeedURL(feed: UpdateFeed) {
		this.feed = feed
	}
	checkForUpdates() {
		this.checks += 1
		return this.checkResult()
	}
	quitAndInstall(silent?: boolean, force?: boolean) {
		this.calls.push(`quitAndInstall:${silent}:${force}`)
	}
}

function build(overrides: { enabled?: boolean; blockers?: () => UpdateBlocker[] } = {}) {
	const updater = new FakeUpdater()
	const states: UpdateState[] = []
	const log: string[] = []
	updater.calls = log
	const records: string[] = []
	let release!: () => void
	let shutdownError: Error | undefined
	const controller = new UpdateController({
		updater: () => updater,
		enabled: overrides.enabled ?? true,
		feed: { provider: 'generic', url: 'http://127.0.0.1:9/feed/' },
		mainBlockers: overrides.blockers ?? (() => []),
		shutdown: async () => {
			log.push('shutdown:start')
			if (shutdownError) throw shutdownError
			await new Promise<void>((resolve) => {
				release = resolve
				queueMicrotask(() => resolve())
			})
			log.push('shutdown:end')
		},
		relaunch: () => log.push('relaunch'),
		broadcast: (state) => states.push(state),
		record: (event) => records.push(event),
	})
	return {
		updater,
		controller,
		states,
		log,
		records,
		failShutdown: (error: Error) => {
			shutdownError = error
		},
		release: () => release?.(),
	}
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('configuration', () => {
	it('treats a build whose app-update.yml names no provider as having no feed', () => {
		expect(bakedFeedDeclared(undefined)).toBe(false)
		expect(bakedFeedDeclared('updaterCacheDirName: namzu-updater\n')).toBe(false)
		expect(bakedFeedDeclared('provider: github\nowner: a\nrepo: b\nupdaterCacheDirName: x\n')).toBe(
			true,
		)
	})
	it('downloads on its own but never installs on quit or downgrades', () => {
		const { updater, controller } = build()
		controller.start()
		expect(updater.autoDownload).toBe(true)
		expect(updater.autoInstallOnAppQuit).toBe(false)
		expect(updater.allowDowngrade).toBe(false)
		expect(updater.feed).toEqual({ provider: 'generic', url: 'http://127.0.0.1:9/feed/' })
		expect(updater.forceDevUpdateConfig).toBe(true)
	})

	it('does nothing when disabled', async () => {
		const { updater, controller } = build({ enabled: false })
		controller.start()
		await vi.advanceTimersByTimeAsync(checkIntervalMs * 2)
		expect(updater.checks).toBe(0)
		expect(controller.state).toEqual({ status: 'disabled' })
	})

	it('reads the feed from the environment, GitHub only when named', () => {
		expect(updateFeedFromEnv({})).toBeUndefined()
		expect(updateFeedFromEnv({ NAMZU_UPDATE_FEED_URL: 'http://localhost:8080/x' })).toEqual({
			provider: 'generic',
			url: 'http://localhost:8080/x',
		})
		expect(updateFeedFromEnv({ NAMZU_UPDATE_FEED_URL: 'file:///etc/passwd' })).toBeUndefined()
		expect(updateFeedFromEnv({ NAMZU_UPDATE_FEED_URL: 'not a url' })).toBeUndefined()
		expect(updateFeedFromEnv({ NAMZU_UPDATE_GITHUB: 'cogitave/namzu' })).toBeUndefined()
		expect(
			updateFeedFromEnv({ NAMZU_UPDATE_PROVIDER: 'github', NAMZU_UPDATE_GITHUB: 'cogitave/namzu' }),
		).toEqual({ provider: 'github', owner: 'cogitave', repo: 'namzu' })
	})

	it('lets an installed app take an environment feed only from loopback or its own repository', () => {
		const packaged = { packaged: true }
		expect(
			updateFeedFromEnv({ NAMZU_UPDATE_FEED_URL: 'http://127.0.0.1:8080/feed' }, packaged),
		).toEqual({ provider: 'generic', url: 'http://127.0.0.1:8080/feed' })
		expect(
			updateFeedFromEnv({ NAMZU_UPDATE_FEED_URL: 'https://updates.example.com/feed' }, packaged),
		).toBeUndefined()
		expect(
			updateFeedFromEnv(
				{ NAMZU_UPDATE_PROVIDER: 'github', NAMZU_UPDATE_GITHUB: 'someone/fork' },
				packaged,
			),
		).toBeUndefined()
		expect(
			updateFeedFromEnv(
				{ NAMZU_UPDATE_PROVIDER: 'github', NAMZU_UPDATE_GITHUB: 'cogitave/namzu' },
				packaged,
			),
		).toEqual({ provider: 'github', owner: 'cogitave', repo: 'namzu' })
		expect(updateFeedFromEnv({ NAMZU_UPDATE_PROVIDER: 'github' })).toBeUndefined()
	})
})

describe('schedule', () => {
	it('checks once after 30 seconds and then every four hours', async () => {
		const { updater, controller } = build()
		controller.start()
		await vi.advanceTimersByTimeAsync(firstCheckDelayMs - 1)
		expect(updater.checks).toBe(0)
		await vi.advanceTimersByTimeAsync(1)
		expect(updater.checks).toBe(1)
		await vi.advanceTimersByTimeAsync(checkIntervalMs)
		expect(updater.checks).toBe(2)
		controller.dispose()
		await vi.advanceTimersByTimeAsync(checkIntervalMs)
		expect(updater.checks).toBe(2)
	})

	it('does not check while a download or a ready update owns the updater', async () => {
		const { updater, controller } = build()
		controller.start()
		updater.emit('update-available')
		await controller.check()
		expect(updater.checks).toBe(0)
		updater.emit('update-downloaded', { version: '2.0.0' })
		await controller.check()
		expect(updater.checks).toBe(0)
	})
})

describe('states', () => {
	it('follows a check through download to ready', () => {
		const { updater, controller, states } = build()
		controller.start()
		updater.emit('checking-for-update')
		updater.emit('update-available', { version: '2.0.0' })
		updater.emit('download-progress', { percent: 41.6, bytesPerSecond: 1234.4 })
		updater.emit('download-progress', { percent: 250, bytesPerSecond: Number.NaN })
		updater.emit('update-downloaded', { version: '2.0.0' })
		expect(states).toEqual([
			{ status: 'checking' },
			{ status: 'downloading', percent: 0, bytesPerSecond: 0 },
			{ status: 'downloading', percent: 42, bytesPerSecond: 1234 },
			{ status: 'downloading', percent: 100, bytesPerSecond: 0 },
			{ status: 'ready', version: '2.0.0' },
		])
	})

	it('returns to idle when there is nothing newer', () => {
		const { updater, controller } = build()
		controller.start()
		updater.emit('checking-for-update')
		updater.emit('update-not-available')
		expect(controller.state).toEqual({ status: 'idle' })
	})

	it('reports a failed check quietly, keeps no details, and recovers on the next check', async () => {
		const { updater, controller, records } = build()
		controller.start()
		updater.checkResult = async () => {
			throw new Error('ENOTFOUND secret.example')
		}
		await controller.check()
		expect(controller.state).toEqual({ status: 'error', message: 'Update check failed.' })
		expect(JSON.stringify(controller.state)).not.toContain('secret')
		expect(records).toEqual(['update_failed'])
		updater.checkResult = async () => undefined
		updater.emit('checking-for-update')
		expect(controller.state.status).toBe('checking')
	})

	it('keeps a downloaded update installable through a later error event', () => {
		const { updater, controller } = build()
		controller.start()
		updater.emit('update-downloaded', { version: '2.0.0' })
		updater.emit('error', new Error('late'))
		expect(controller.state).toEqual({ status: 'ready', version: '2.0.0' })
	})
})

describe('install gate', () => {
	it('refuses when nothing is ready', async () => {
		const { controller, updater } = build()
		controller.start()
		expect(await controller.install()).toEqual({
			ok: false,
			error: 'No update is ready to install.',
		})
		expect(updater.calls).toEqual([])
	})

	it('names what blocks and installs nothing', async () => {
		let blocked: UpdateBlocker[] = ['turn-running', 'permission-pending']
		const { updater, controller, log } = build({ blockers: () => blocked })
		controller.start()
		updater.emit('update-downloaded', { version: '2.0.0' })
		expect(await controller.install()).toEqual({
			ok: false,
			blockers: ['turn-running', 'permission-pending'],
		})
		expect(controller.state).toEqual({
			status: 'ready',
			version: '2.0.0',
			waiting: ['turn-running', 'permission-pending'],
		})
		expect(log).toEqual([])
		blocked = []
	})

	it('merges window reports and counts any window', async () => {
		const { updater, controller } = build()
		controller.start()
		updater.emit('update-downloaded', { version: '2.0.0' })
		controller.report('a', { dialogOpen: false, typingRecent: false, computerSession: false })
		controller.report('b', { dialogOpen: true, typingRecent: true, computerSession: false })
		controller.report('c', { nonsense: true })
		expect(controller.blockers()).toEqual(['dialog-open', 'typing-unsaved'])
		controller.forgetWindow('b')
		expect(controller.blockers()).toEqual([])
		expect(uiBlockers([{ dialogOpen: false, typingRecent: false, computerSession: true }])).toEqual(
			['computer-session'],
		)
	})

	it('installs at the next idle moment only after Restart, and not after Later', async () => {
		let blocked: UpdateBlocker[] = ['turn-running']
		const { updater, controller, log } = build({ blockers: () => blocked })
		controller.start()
		updater.emit('update-downloaded', { version: '2.0.0' })
		await vi.advanceTimersByTimeAsync(idleRetryMs * 3)
		blocked = []
		await vi.advanceTimersByTimeAsync(idleRetryMs * 3)
		// Never chosen, so nothing installs just because the app went idle.
		expect(log).toEqual([])
		blocked = ['turn-running']
		await controller.install()
		await vi.advanceTimersByTimeAsync(idleRetryMs * 2)
		expect(log).toEqual([])
		blocked = []
		await vi.advanceTimersByTimeAsync(idleRetryMs)
		expect(log).toEqual(['shutdown:start', 'shutdown:end', 'quitAndInstall:true:true'])

		const later = build({ blockers: () => ['turn-running'] })
		later.controller.start()
		later.updater.emit('update-downloaded', { version: '2.0.0' })
		await later.controller.install()
		later.controller.cancel()
		expect(later.controller.state).toEqual({ status: 'ready', version: '2.0.0' })
		await vi.advanceTimersByTimeAsync(idleRetryMs * 5)
		expect(later.log).toEqual([])
	})

	it('updates the named reasons while it waits', async () => {
		let blocked: UpdateBlocker[] = ['turn-running']
		const { updater, controller, states } = build({ blockers: () => blocked })
		controller.start()
		updater.emit('update-downloaded', { version: '2.0.0' })
		await controller.install()
		blocked = ['permission-pending']
		await vi.advanceTimersByTimeAsync(idleRetryMs)
		expect(states.at(-1)).toEqual({
			status: 'ready',
			version: '2.0.0',
			waiting: ['permission-pending'],
		})
	})
})

describe('ordering', () => {
	it('finishes our shutdown before the installer starts', async () => {
		const { updater, controller, log, states } = build()
		controller.start()
		updater.emit('update-downloaded', { version: '2.0.0' })
		expect(await controller.install()).toEqual({ ok: true })
		expect(log).toEqual(['shutdown:start', 'shutdown:end', 'quitAndInstall:true:true'])
		expect(states.slice(-2)).toEqual([
			{ status: 'installing', version: '2.0.0', phase: 'preparing' },
			{ status: 'installing', version: '2.0.0', phase: 'installing' },
		])
	})

	it('does not install when the shutdown fails, and offers the update again', async () => {
		const { updater, controller, log, failShutdown } = build()
		controller.start()
		updater.emit('update-downloaded', { version: '2.0.0' })
		failShutdown(new Error('could not confirm that all runtime processes stopped'))
		expect(await controller.install()).toEqual({ ok: false, error: 'Shutdown failed.' })
		expect(log).toEqual(['shutdown:start'])
		expect(controller.state).toMatchObject({ status: 'ready', version: '2.0.0' })
		expect(JSON.stringify(controller.state)).not.toContain('runtime processes')
		controller.cancel()
		expect(controller.state).toEqual({ status: 'ready', version: '2.0.0' })
	})

	it('starts the app again when the installer refuses after the runtime stopped', async () => {
		const { updater, controller, log } = build()
		controller.start()
		updater.emit('update-downloaded', { version: '2.0.0' })
		await controller.install()
		updater.emit('error', new Error('No update filepath provided'))
		expect(log.at(-1)).toBe('relaunch')
	})

	it('installs once however many times Restart is pressed', async () => {
		const { updater, controller, log } = build()
		controller.start()
		updater.emit('update-downloaded', { version: '2.0.0' })
		const first = controller.install()
		const second = controller.install()
		await Promise.all([first, second])
		expect(log.filter((entry) => entry.startsWith('quitAndInstall'))).toHaveLength(1)
	})
})
