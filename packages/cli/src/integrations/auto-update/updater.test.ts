import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type InstallerRequest, type Release, scopeOf } from './apply.js'
import type { InstallKind } from './install-kind.js'
import { readInstalledVersion } from './installed-version.js'
import type { UpdatePolicy } from './policy.js'
import { acquireUpdateLock, readCheck, readLastResult } from './state.js'
import {
	CHECK_EVERY_MS,
	FIRST_CHECK_AFTER_MS,
	MAX_CONSECUTIVE_FAILURES,
	SHARED_THROTTLE_MS,
	type UpdaterDeps,
	type UpdaterEvent,
	createUpdater,
} from './updater.js'

let dir: string
let home: string
let root: string

function writePackage(version: string): void {
	mkdirSync(root, { recursive: true })
	writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@namzu/cli', version }))
}

/** The folder the test install's lock and marker are filed under. */
const scope = () =>
	scopeOf(
		{ kind: 'npm-global', root, prefix: join(dir, 'prefix'), owned: false, writable: true },
		'linux',
	)

const policy = (over: Partial<UpdatePolicy> = {}): UpdatePolicy => ({
	check: true,
	install: true,
	channel: 'latest',
	decidedBy: 'default',
	...over,
})

beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2026-10-27T10:00:00Z'))
	dir = mkdtempSync(join(tmpdir(), 'namzu-updater-'))
	home = join(dir, 'home')
	root = join(dir, 'prefix', 'lib', 'node_modules', '@namzu', 'cli')
	writePackage('1.0.0')
})
afterEach(() => {
	vi.useRealTimers()
	rmSync(dir, { recursive: true, force: true })
})

function harness(
	over: Partial<UpdaterDeps> = {},
	release: Release = { version: '2.0.0', integrity: 'sha512-AAAA' },
	failWith?: string,
) {
	const events: UpdaterEvent[] = []
	const fetchRelease = vi.fn(async (_channel: 'latest' | 'stable') => release)
	const installs: InstallerRequest[] = []
	const install: InstallKind = {
		kind: 'npm-global',
		root,
		prefix: join(dir, 'prefix'),
		owned: false,
		writable: true,
	}
	const deps: UpdaterDeps = {
		currentVersion: '1.0.0',
		install,
		policy: policy(),
		home,
		platform: 'linux',
		fetchRelease,
		uptimeMs: () => 0,
		onEvent: (event) => events.push(event),
		applyDeps: {
			installedVersion: readInstalledVersion,
			smokeTest: async (at, version) => readInstalledVersion(at) === version,
			pid: 4242,
			isAlive: () => true,
			runInstaller: async (request) => {
				installs.push(request)
				if (failWith !== undefined) {
					request.onOutput(failWith)
					return 1
				}
				writePackage('2.0.0')
				return 0
			},
		},
		...over,
	}
	const updater = createUpdater(deps)
	return { updater, events, fetchRelease, installs, deps }
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms)

describe('when the loop looks', () => {
	it('waits until the process is ten seconds old, counting the time already passed', async () => {
		const h = harness({ uptimeMs: () => 4_000 })
		h.updater.start()
		await tick(FIRST_CHECK_AFTER_MS - 4_000 - 1)
		expect(h.fetchRelease).not.toHaveBeenCalled()
		await tick(1)
		expect(h.fetchRelease).toHaveBeenCalledTimes(1)
		h.updater.stop()
	})

	it('looks at once when the process is already older than that', async () => {
		const h = harness({ uptimeMs: () => 60_000 })
		h.updater.start()
		await tick(0)
		expect(h.fetchRelease).toHaveBeenCalledTimes(1)
		h.updater.stop()
	})

	it('looks again every thirty minutes while the terminal stays open', async () => {
		const h = harness({}, { version: '1.0.0', integrity: 'sha512-AAAA' })
		h.updater.start()
		await tick(FIRST_CHECK_AFTER_MS)
		expect(h.fetchRelease).toHaveBeenCalledTimes(1)
		await tick(CHECK_EVERY_MS)
		expect(h.fetchRelease).toHaveBeenCalledTimes(2)
		await tick(CHECK_EVERY_MS)
		expect(h.fetchRelease).toHaveBeenCalledTimes(3)
		h.updater.stop()
		await tick(CHECK_EVERY_MS * 2)
		expect(h.fetchRelease).toHaveBeenCalledTimes(3)
	})

	it('does not start twice', async () => {
		const h = harness({}, { version: '1.0.0' })
		h.updater.start()
		h.updater.start()
		await tick(FIRST_CHECK_AFTER_MS)
		expect(h.fetchRelease).toHaveBeenCalledTimes(1)
		h.updater.stop()
	})

	it('shares one look between processes started within five minutes', async () => {
		const first = harness({}, { version: '2.0.0', integrity: 'sha512-AAAA' })
		await first.updater.runCycle()
		expect(first.fetchRelease).toHaveBeenCalledTimes(1)
		writePackage('1.0.0')
		const second = harness({ policy: policy({ install: false }) })
		await tick(SHARED_THROTTLE_MS - 1)
		await second.updater.runCycle()
		expect(second.fetchRelease).not.toHaveBeenCalled()
		expect(second.events).toEqual([expect.objectContaining({ type: 'available', latest: '2.0.0' })])
		await tick(1)
		const third = harness({ policy: policy({ install: false }) })
		await third.updater.runCycle()
		expect(third.fetchRelease).toHaveBeenCalledTimes(1)
	})

	it('does not reuse another channel’s answer', async () => {
		const stable = harness({ policy: policy({ channel: 'stable', install: false }) })
		await stable.updater.runCycle()
		expect(readCheck(home)?.channel).toBe('stable')
		const latest = harness({ policy: policy({ install: false }) })
		await latest.updater.runCycle()
		expect(latest.fetchRelease).toHaveBeenCalledWith('latest')
	})
})

describe('what it never touches', () => {
	it.each(['development', 'ephemeral', 'desktop'] as const)(
		'does not even look in a %s copy',
		async (kind) => {
			const h = harness({ install: { kind, root } as InstallKind })
			await h.updater.runCycle()
			expect(h.fetchRelease).not.toHaveBeenCalled()
			expect(h.events).toEqual([])
		},
	)

	it('does not look when checking is off', async () => {
		const h = harness({ policy: policy({ check: false, install: false }) })
		await h.updater.runCycle()
		expect(h.fetchRelease).not.toHaveBeenCalled()
		expect(h.events).toEqual([])
	})

	it('says an unknown layout cannot be updated from here, with nothing to run', async () => {
		const h = harness({ install: { kind: 'unknown', root } })
		await h.updater.runCycle()
		expect(h.events).toEqual([{ type: 'available', latest: '2.0.0', command: null }])
		expect(h.installs).toEqual([])
	})

	it('stays quiet when up to date, when offline, and when the registry is behind', async () => {
		const upToDate = harness({}, { version: '1.0.0' })
		await upToDate.updater.runCycle()
		const behind = harness({}, { version: '0.9.0' })
		await behind.updater.runCycle()
		const offline = harness({
			fetchRelease: vi.fn(async () => Promise.reject(new Error('offline'))),
		})
		await offline.updater.runCycle()
		expect([...upToDate.events, ...behind.events, ...offline.events]).toEqual([])
	})
})

describe('installing, or telling', () => {
	it('installs in the background and reports it once', async () => {
		const h = harness()
		h.updater.start()
		await tick(FIRST_CHECK_AFTER_MS)
		expect(h.events).toEqual([{ type: 'installed', from: '1.0.0', to: '2.0.0' }])
		expect(h.installs).toHaveLength(1)
		expect(readLastResult(home)).toMatchObject({ outcome: 'installed', from: '1.0.0', to: '2.0.0' })
		await tick(CHECK_EVERY_MS * 3)
		expect(h.fetchRelease).toHaveBeenCalledTimes(1)
		expect(h.events).toHaveLength(1)
		h.updater.stop()
	})

	it('only tells the person, with the command, when installing is off', async () => {
		const h = harness({ policy: policy({ install: false, decidedBy: 'ci' }) })
		await h.updater.runCycle()
		expect(h.installs).toEqual([])
		expect(h.events).toEqual([{ type: 'available', latest: '2.0.0', command: 'namzu upgrade' }])
	})

	it('tells the person the exact command, and does not try, where the folder is not writable', async () => {
		const h = harness({
			install: { kind: 'npm-global', root, prefix: '/usr', owned: false, writable: false },
		})
		await h.updater.runCycle()
		expect(h.installs).toEqual([])
		expect(h.events).toEqual([
			{
				type: 'available',
				latest: '2.0.0',
				command: 'sudo npm install --global --prefix /usr @namzu/cli@2.0.0',
			},
		])
	})

	it('stays silent while another process is updating and tries again next time', async () => {
		const held = acquireUpdateLock({ home, scope: scope(), pid: 77, isAlive: () => true })
		const h = harness()
		await h.updater.runCycle()
		expect(h.events).toEqual([])
		held?.release()
		await tick(SHARED_THROTTLE_MS)
		await h.updater.runCycle()
		expect(h.events).toEqual([{ type: 'installed', from: '1.0.0', to: '2.0.0' }])
	})

	it('reports an install another process finished without installing again', async () => {
		writePackage('2.0.0')
		const h = harness()
		await h.updater.runCycle()
		expect(h.installs).toEqual([])
		expect(h.events).toEqual([{ type: 'installed', from: '1.0.0', to: '2.0.0' }])
	})
})

describe('when installing fails', () => {
	it('keeps the old version, tells the person once, and never retries after a refused write', async () => {
		const h = harness({}, undefined, 'npm error code EACCES')
		const updater = h.updater
		await updater.runCycle()
		await tick(SHARED_THROTTLE_MS)
		await updater.runCycle()
		expect(h.installs).toHaveLength(1)
		expect(readInstalledVersion(root)).toBe('1.0.0')
		expect(h.events).toEqual([
			{
				type: 'available',
				latest: '2.0.0',
				command: 'sudo npm install --global --prefix '.concat(
					join(dir, 'prefix'),
					' @namzu/cli@2.0.0',
				),
				failure: 'no_permission',
			},
		])
		expect(readLastResult(home)).toMatchObject({ outcome: 'failed', status: 'no_permission' })
	})

	it('tries a few times for other failures, then stops until the next start', async () => {
		const h = harness({}, undefined, 'npm error something odd')
		const updater = h.updater
		for (let i = 0; i < MAX_CONSECUTIVE_FAILURES + 2; i += 1) {
			await updater.runCycle()
			await tick(SHARED_THROTTLE_MS)
		}
		expect(h.installs).toHaveLength(MAX_CONSECUTIVE_FAILURES)
		expect(h.events).toHaveLength(1)
		expect(h.events[0]).toMatchObject({ type: 'available', failure: 'install_failed' })
	})

	it('does not install a version the registry gave no checksum for', async () => {
		const h = harness({}, { version: '2.0.0' })
		await h.updater.runCycle()
		expect(h.installs).toEqual([])
		expect(h.events[0]).toMatchObject({ type: 'available', failure: 'unverifiable' })
	})
})

describe('repairing with installing switched off', () => {
	it('leaves an unfinished update alone', async () => {
		mkdirSync(join(home, 'updates'), { recursive: true })
		writeFileSync(
			join(home, 'updates', `in-progress-${scope()}.json`),
			JSON.stringify({ pid: 99_999_999, from: '1.0.0', to: '2.0.0', at: Date.now() }),
		)
		const h = harness({ policy: policy({ install: false }) })
		await h.updater.repair()
		expect(existsSync(join(home, 'updates', `in-progress-${scope()}.json`))).toBe(true)
		expect(readLastResult(home)).toBeUndefined()
	})
})
