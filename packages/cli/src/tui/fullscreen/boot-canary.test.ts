import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readTerminalState, updateTerminalState } from '../../terminal-setup/state.js'
import {
	type BootWorld,
	HEALTHY_AFTER_MS,
	ONE_FAILED_START_LINE,
	REPEATED_FAILED_START_LINE,
	armBootCanary,
	clearFailedStarts,
	evaluateBoot,
	failedStartOnRecord,
	settleEarlierStarts,
} from './boot-canary.js'

const world = (over: Partial<BootWorld> = {}): BootWorld => ({
	now: 1_000_000,
	version: '1.0.0',
	host: 'h',
	platform: 'linux',
	ownPid: 900,
	isGone: () => true,
	...over,
})

const pending = (version = '1.0.0', over = {}) => ({
	startedAt: 999_000,
	version,
	host: 'h',
	platform: 'linux',
	...over,
})

describe('evaluateBoot', () => {
	it('says nothing when nothing is left', () => {
		expect(evaluateBoot({}, world()).decision).toEqual({ kind: 'none' })
	})

	it('counts one failed start for a record whose process is gone', () => {
		const { decision, next } = evaluateBoot({ fullscreenBootPending: { '5': pending() } }, world())
		expect(decision).toEqual({ kind: 'strike', strikes: 1 })
		expect(next.fullscreenBootStrikes).toEqual({ count: 1, version: '1.0.0' })
		expect(next.fullscreenBootPending).toBeUndefined()
	})

	it('turns fullscreen off after two, and the record is tied to the version', () => {
		const first = evaluateBoot({ fullscreenBootPending: { '5': pending() } }, world()).next
		const second = evaluateBoot({ ...first, fullscreenBootPending: { '6': pending() } }, world())
		expect(second.decision).toEqual({ kind: 'tripped', strikes: 2 })
		expect(second.next.fullscreenAutoDisabled?.version).toBe('1.0.0')
		expect(evaluateBoot(second.next, world()).decision).toEqual({ kind: 'disabled' })
		// a newer version tries again
		expect(evaluateBoot(second.next, world({ version: '1.0.1' })).decision).toEqual({
			kind: 'none',
		})
	})

	it('leaves a live process, another machine and an older version alone', () => {
		const live = evaluateBoot(
			{ fullscreenBootPending: { '5': pending() } },
			world({ isGone: () => false }),
		)
		expect(live.decision).toEqual({ kind: 'pending_alive' })
		const other = evaluateBoot(
			{ fullscreenBootPending: { '5': pending('1.0.0', { host: 'x' }) } },
			world(),
		)
		expect(other.decision).toEqual({ kind: 'none' })
		expect(other.next.fullscreenBootPending).toBeDefined()
		const old = evaluateBoot({ fullscreenBootPending: { '5': pending('0.9.0') } }, world())
		expect(old.decision).toEqual({ kind: 'none' })
	})

	it('counts a record whose interface died drawing, even if the process is alive', () => {
		const r = evaluateBoot(
			{ fullscreenBootPending: { '5': pending('1.0.0', { died: 'render_error' }) } },
			world({ isGone: () => false }),
		)
		expect(r.decision.kind).toBe('strike')
	})

	it('drops a live record older than ten minutes', () => {
		const r = evaluateBoot(
			{ fullscreenBootPending: { '5': pending('1.0.0', { startedAt: 1_000_000 - 11 * 60_000 }) } },
			world({ isGone: () => false }),
		)
		expect(r.next.fullscreenBootPending).toBeUndefined()
	})
})

describe('the canary across launches', () => {
	let home: string
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), 'namzu-canary-'))
		vi.useFakeTimers()
	})
	afterEach(() => vi.useRealTimers())

	it('a launch that stays healthy leaves no record', () => {
		const canary = armBootCanary({ home, world: world(), onExit: () => () => undefined })
		expect(readTerminalState(home).fullscreenBootPending?.['900']).toBeDefined()
		canary.firstFrame()
		vi.advanceTimersByTime(HEALTHY_AFTER_MS)
		expect(readTerminalState(home).fullscreenBootPending).toBeUndefined()
	})

	it('a launch that ends cleanly leaves no record', () => {
		const canary = armBootCanary({ home, world: world(), onExit: () => () => undefined })
		canary.retire()
		expect(readTerminalState(home).fullscreenBootPending).toBeUndefined()
	})

	it('a launch that dies before it is healthy is a strike for the next one', () => {
		armBootCanary({ home, world: world({ ownPid: 5 }), onExit: () => () => undefined })
		const next = settleEarlierStarts({ home, world: world() })
		expect(next.autoOff).toBe(true)
		expect(next.line).toBe(ONE_FAILED_START_LINE)
		expect(failedStartOnRecord(home, '1.0.0')).toBe('once')
	})

	it('a failure while drawing is counted even while the process lives', () => {
		const canary = armBootCanary({
			home,
			world: world({ ownPid: 5 }),
			onExit: () => () => undefined,
		})
		canary.failed()
		const next = settleEarlierStarts({ home, world: world({ isGone: () => false }) })
		expect(next.decision.kind).toBe('strike')
	})

	it('two failed starts turn it off, say so, and /tui forgets them', () => {
		for (const pid of [5, 6]) {
			armBootCanary({ home, world: world({ ownPid: pid }), onExit: () => () => undefined })
			const settled = settleEarlierStarts({ home, world: world({ ownPid: 900 + pid }) })
			if (pid === 6) {
				expect(settled.line).toBe(REPEATED_FAILED_START_LINE)
				expect(settled.autoOff).toBe(true)
			}
		}
		expect(failedStartOnRecord(home, '1.0.0')).toBe('repeated')
		expect(settleEarlierStarts({ home, world: world() }).line).toBeUndefined()
		clearFailedStarts(home)
		expect(failedStartOnRecord(home, '1.0.0')).toBeUndefined()
		expect(settleEarlierStarts({ home, world: world() }).autoOff).toBe(false)
	})

	it('keeps what else the state file holds', () => {
		updateTerminalState((s) => ({ ...s, shiftEnterInstalled: true }), home)
		armBootCanary({ home, world: world({ ownPid: 5 }), onExit: () => () => undefined })
		settleEarlierStarts({ home, world: world() })
		clearFailedStarts(home)
		expect(readTerminalState(home).shiftEnterInstalled).toBe(true)
	})
})
