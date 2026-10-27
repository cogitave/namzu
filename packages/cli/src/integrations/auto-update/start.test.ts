import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { startAutoUpdate } from './start.js'

let home: string
beforeEach(() => {
	vi.useFakeTimers()
	home = mkdtempSync(join(tmpdir(), 'namzu-start-'))
})
afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
	rmSync(home, { recursive: true, force: true })
})

describe('starting the background updater', () => {
	it('never goes to the network from a source checkout, which is what these tests run in', async () => {
		const fetchSpy = vi.fn(async () => new Response('{}'))
		vi.stubGlobal('fetch', fetchSpy)
		const events: unknown[] = []
		const running = startAutoUpdate({
			currentVersion: '1.0.0',
			env: { NAMZU_HOME: home },
			onEvent: (event) => events.push(event),
		})
		await vi.advanceTimersByTimeAsync(60 * 60_000)
		running.stop()
		expect(fetchSpy).not.toHaveBeenCalled()
		expect(events).toEqual([])
	})

	it('does nothing at all when checking is switched off', async () => {
		const fetchSpy = vi.fn(async () => new Response('{}'))
		vi.stubGlobal('fetch', fetchSpy)
		const running = startAutoUpdate({
			currentVersion: '1.0.0',
			env: { NAMZU_HOME: home, NAMZU_UPDATE_CHECK: '0' },
			onEvent: () => undefined,
		})
		expect(running.policy).toMatchObject({ check: false, install: false })
		await vi.advanceTimersByTimeAsync(60 * 60_000)
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it('reports the policy it runs under', () => {
		const running = startAutoUpdate({
			currentVersion: '1.0.0',
			config: { channel: 'stable' },
			env: { NAMZU_HOME: home, CI: 'true' },
			onEvent: () => undefined,
		})
		running.stop()
		expect(running.policy).toMatchObject({ install: false, channel: 'stable', decidedBy: 'ci' })
	})
})
