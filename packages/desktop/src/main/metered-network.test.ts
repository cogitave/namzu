import { describe, expect, it, vi } from 'vitest'
import type { MeteredState } from '../shared/os-state.js'
import { METERED_RECHECK_MS, MeteredWatch, parseCostType } from './metered-network.js'

describe('connection cost', () => {
	it('reads the word the system answers', () => {
		expect(parseCostType('Unrestricted\r\n')).toBe('unmetered')
		expect(parseCostType('Fixed')).toBe('metered')
		expect(parseCostType('variable\n')).toBe('metered')
		expect(parseCostType('Unknown')).toBe('unknown')
		expect(parseCostType('None')).toBe('unknown')
		expect(parseCostType('')).toBe('unknown')
	})
})

function watch(answers: (string | Error)[], withQuery = true) {
	const changes: MeteredState[] = []
	let beat: (() => void) | undefined
	const stop = vi.fn()
	const queue = [...answers]
	const query = vi.fn(async () => {
		const next = queue.shift() ?? 'Unknown'
		if (next instanceof Error) throw next
		return next
	})
	const subject = new MeteredWatch({
		...(withQuery ? { query } : {}),
		every: (ms, run) => {
			expect(ms).toBe(METERED_RECHECK_MS)
			beat = run
			return stop
		},
		onChange: (state) => changes.push(state),
	})
	return { subject, changes, query, stop, beat: () => beat?.() }
}

/** Lets the promise chains a started check sets going settle; no clock involved. */
const settle = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('the metered watch', () => {
	it('is unknown, and reports nothing, where the cost cannot be read', async () => {
		const { subject, changes } = watch([], false)
		subject.start()
		expect(subject.available()).toBe(false)
		expect(await subject.refresh()).toBe('unknown')
		expect(changes).toEqual([])
	})

	it('tells a change once and keeps the last answer', async () => {
		const { subject, changes } = watch(['Fixed', 'Fixed', 'Unrestricted'])
		expect(await subject.refresh()).toBe('metered')
		expect(await subject.refresh()).toBe('metered')
		expect(await subject.refresh()).toBe('unmetered')
		expect(changes).toEqual(['metered', 'unmetered'])
	})

	it('treats a failed question as unknown, so nothing waits on a guess', async () => {
		const { subject, changes } = watch(['Fixed', new Error('timed out')])
		await subject.refresh()
		await subject.refresh()
		expect(subject.state()).toBe('unknown')
		expect(changes).toEqual(['metered', 'unknown'])
	})

	it('asks at start and on the slow beat, and stops when closed', async () => {
		const { subject, query, stop, beat } = watch(['Fixed', 'Unrestricted'])
		subject.start()
		subject.start()
		await settle()
		expect(subject.state()).toBe('metered')
		beat()
		await settle()
		expect(subject.state()).toBe('unmetered')
		expect(query).toHaveBeenCalledTimes(2)
		subject.close()
		expect(stop).toHaveBeenCalledTimes(1)
	})
})
