import { describe, expect, it } from 'vitest'
import { emptyState } from './state.js'
import { STALE_AFTER_MS, buildEngineView, engineStatus, problemOf } from './view.js'

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0)
const base = {
	available: true,
	enabled: true,
	override: false,
	state: emptyState(),
	running: { source: 'bundled' as const, commandLine: '51.1.0', engine: '62.13.0' },
	bundled: { commandLine: '51.1.0', engine: '62.13.0' },
	checking: false,
	now: NOW,
}
const withState = (change: (state: ReturnType<typeof emptyState>) => void) => {
	const state = emptyState()
	change(state)
	return { ...base, state }
}

describe('the engine status', () => {
	it('is not checked yet before any answer', () => {
		expect(engineStatus(base)).toEqual({ kind: 'unknown' })
	})

	it('is up to date after a fresh answer, and not worrying for three days without one', () => {
		const state = withState((s) => {
			s.lastFreshCheckAt = NOW - STALE_AFTER_MS
		})
		expect(engineStatus(state)).toEqual({ kind: 'current', checkedAt: NOW - STALE_AFTER_MS })
		expect(engineStatus({ ...state, now: NOW + 1 })).toEqual({
			kind: 'cannot-check',
			since: NOW - STALE_AFTER_MS,
		})
	})

	it('puts off, override and checking before anything stored', () => {
		const stored = withState((s) => {
			s.pending = '52.0.0'
			s.lastFreshCheckAt = NOW
		})
		expect(engineStatus({ ...stored, enabled: false })).toEqual({ kind: 'off' })
		expect(engineStatus({ ...stored, override: true })).toEqual({ kind: 'override' })
		expect(engineStatus({ ...stored, override: true, enabled: false })).toEqual({
			kind: 'override',
		})
		expect(engineStatus({ ...stored, checking: true })).toEqual({ kind: 'checking' })
		expect(engineStatus(stored)).toEqual({ kind: 'ready', version: '52.0.0' })
	})

	it('says it went back for a failure after the engine in use took over, in a fixed kind', () => {
		const state = withState((s) => {
			s.updatedAt = NOW - 5000
			s.bad['52.0.0'] = {
				reason: 'host failed (spawn ENOENT C:\\Users\\person\\x)',
				at: NOW - 1000,
			}
			s.bad['51.9.0'] = { reason: 'it ended early twice', at: NOW - 3000 }
		})
		expect(engineStatus(state)).toEqual({
			kind: 'went-back',
			version: '52.0.0',
			problem: 'did-not-start',
			to: '51.1.0',
		})
		// Nothing of the stored reason is in what the screen gets.
		expect(JSON.stringify(buildEngineView(state))).not.toContain('person')
	})

	it('does not say it went back for a give-up that is older than the engine in use, withdrawn, or chosen by the person', () => {
		const state = withState((s) => {
			s.updatedAt = NOW
			s.bad['52.0.0'] = { reason: 'it ended early twice', at: NOW - 1 }
			s.bad['52.1.0'] = { reason: 'withdrawn', at: NOW + 10 }
			s.bad['52.2.0'] = { reason: 'the person chose this app’s own engine', at: NOW + 20 }
		})
		expect(engineStatus(state)).toEqual({ kind: 'unknown' })
	})

	it('says a newer engine needs a newer app from the last check', () => {
		const state = withState((s) => {
			s.lastCheck = { at: NOW, kind: 'needs-newer-app' }
			s.lastFreshCheckAt = NOW
		})
		expect(engineStatus(state)).toEqual({ kind: 'needs-newer-app' })
	})

	it('sorts a stored reason into one of three fixed kinds, or into none', () => {
		expect(problemOf('host failed (x)')).toBe('did-not-start')
		expect(problemOf('it ended early twice')).toBe('ended-early')
		expect(problemOf('files.json changed')).toBe('failed-checks')
		expect(problemOf('withdrawn')).toBeUndefined()
		expect(problemOf('the person chose this app’s own engine')).toBeUndefined()
	})

	it('offers the way back to this app’s own engine only when a fetched one runs or would run', () => {
		expect(buildEngineView(base).canUseOwn).toBe(false)
		expect(
			buildEngineView(
				withState((s) => {
					s.current = '52.0.0'
				}),
			).canUseOwn,
		).toBe(true)
		expect(
			buildEngineView({ ...base, running: { source: 'managed', commandLine: '52.0.0' } }).canUseOwn,
		).toBe(true)
		// A waiting engine alone: the app's own engine runs, so there is nothing to go back from.
		expect(
			buildEngineView(
				withState((s) => {
					s.pending = '52.0.0'
				}),
			).canUseOwn,
		).toBe(false)
	})
})
