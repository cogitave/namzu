import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	WAIT_LIMIT_MS,
	WAIT_POLL_MS,
	type WaitThenApplyDeps,
	waitThenApply,
} from './apply-at-exit.js'
import { scopeOf, sharedStateHome } from './apply.js'
import type { InstallKind } from './install-kind.js'
import { acquireUpdateLock } from './state.js'
import type { UpdaterEvent } from './updater.js'

let dir: string
let install: Extract<InstallKind, { kind: 'npm-global' }>
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'namzu-at-exit-'))
	mkdirSync(join(dir, 'prefix'), { recursive: true })
	install = {
		kind: 'npm-global',
		root: join(dir, 'prefix', 'lib', 'node_modules', '@namzu', 'cli'),
		prefix: join(dir, 'prefix'),
		owned: false,
		writable: true,
	}
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A fake clock: sleeping moves it, nothing waits for real. */
function harness(over: Partial<WaitThenApplyDeps> & { running?: number[][] } = {}) {
	let clock = 1_000_000
	const running = over.running ?? [[]]
	let look = 0
	const cycles: string[] = []
	const deps: WaitThenApplyDeps = {
		install,
		platform: process.platform,
		home: join(dir, 'home'),
		others: () => running[Math.min(look++, running.length - 1)] as number[],
		cycle: async () => {
			cycles.push('cycle')
			return [{ type: 'installed', from: '1.0.0', to: '2.0.0' }] as UpdaterEvent[]
		},
		sleep: async (ms) => {
			clock += ms
		},
		now: () => clock,
		isAlive: () => true,
		pid: 777,
		...over,
	}
	return { deps, cycles, clock: () => clock }
}

describe('installing after the session, never under another one', () => {
	it('installs at once when nothing else runs from the install', async () => {
		const h = harness()
		expect(await waitThenApply(h.deps)).toBe('done')
		expect(h.cycles).toHaveLength(1)
	})

	it('waits for a second window to end, and never installs while it runs', async () => {
		const h = harness({ running: [[501], [501], [501], []] })
		expect(await waitThenApply(h.deps)).toBe('done')
		expect(h.cycles).toHaveLength(1)
		// Three looks found the window; each wait was one poll of the fake clock.
		expect(h.clock() - 1_000_000).toBe(3 * WAIT_POLL_MS)
	})

	it('looks again when the cycle found a window started meanwhile (idle), and finishes when it ends', async () => {
		let n = 0
		const h = harness({
			cycle: async () => {
				n++
				return n === 1 ? [{ type: 'idle' }] : [{ type: 'installed', from: '1.0.0', to: '2.0.0' }]
			},
		})
		expect(await waitThenApply(h.deps)).toBe('done')
		expect(n).toBe(2)
	})

	it('gives up after the limit and leaves the update for the next session to end', async () => {
		const h = harness({ running: [[9]] })
		expect(await waitThenApply(h.deps)).toBe('gave-up')
		expect(h.cycles).toHaveLength(0)
		expect(h.clock() - 1_000_000).toBeGreaterThanOrEqual(WAIT_LIMIT_MS)
	})

	it('lets one waiting installer serve everyone: a second one leaves at once', async () => {
		const held = acquireUpdateLock({
			home: sharedStateHome(install),
			scope: `${scopeOf(install, process.platform)}-exit`,
			pid: 1,
			isAlive: () => true,
		})
		expect(held).not.toBeNull()
		const h = harness()
		expect(await waitThenApply(h.deps)).toBe('another-waits')
		expect(h.cycles).toHaveLength(0)
		held?.release()
	})

	it('releases its place when it is done, so the next session can start one', async () => {
		const h = harness()
		await waitThenApply(h.deps)
		const again = harness()
		expect(await waitThenApply(again.deps)).toBe('done')
	})
})

describe('the poll', () => {
	it('is a few seconds, not a busy loop, and the limit is hours', () => {
		expect(WAIT_POLL_MS).toBeGreaterThanOrEqual(5_000)
		expect(WAIT_LIMIT_MS).toBeGreaterThanOrEqual(60 * 60_000)
	})
})
