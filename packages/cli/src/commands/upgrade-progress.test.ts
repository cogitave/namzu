import { stripVTControlCharacters } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NAMZU_COMPACT_WORDMARK, NAMZU_WORDMARK } from '../tui/logo.js'
import { startUpgradeProgress, upgradeFrame } from './upgrade-progress.js'

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllEnvs()
})
describe('upgrade wordmark', () => {
	it('preserves the wordmark and uses the compact signature on narrow terminals', () => {
		expect(stripVTControlCharacters(upgradeFrame(3, 80))).toBe(NAMZU_WORDMARK)
		expect(stripVTControlCharacters(upgradeFrame(3, 20))).toBe(NAMZU_COMPACT_WORDMARK)
		expect(upgradeFrame(0, 80, true)).not.toContain('\x1b[90m')
	})
	it('animates in place, and stops repainting after completion', () => {
		vi.useFakeTimers()
		vi.stubEnv('TERM', 'xterm')
		vi.stubEnv('NO_COLOR', undefined)
		const write = vi.fn()
		const before = process.listenerCount('exit')
		const progress = startUpgradeProgress({ isTTY: true, columns: 80, write })!
		vi.advanceTimersByTime(180)
		expect(write.mock.calls.flat().join('')).toContain('\x1b[2A\r\x1b[J')
		progress.stop(true)
		const calls = write.mock.calls.length
		vi.advanceTimersByTime(900)
		progress.stop()
		expect(write).toHaveBeenCalledTimes(calls)
		expect(process.listenerCount('exit')).toBe(before)
	})
	it('keeps redirected, no-color and dumb output static', () => {
		const write = vi.fn()
		expect(startUpgradeProgress({ write })).toBeUndefined()
		vi.stubEnv('NO_COLOR', '1')
		expect(startUpgradeProgress({ isTTY: true, columns: 80, write })).toBeUndefined()
		expect(write).not.toHaveBeenCalled()
	})
})
