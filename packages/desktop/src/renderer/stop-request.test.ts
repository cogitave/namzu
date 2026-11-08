import { describe, expect, it } from 'vitest'
import { clearStop, isStopping, requestStop } from './stop-request.js'

const running = { running: true, turn: 3 }

describe('stop requests', () => {
	it('say "stopping" for the turn the stop was asked for, while it runs', () => {
		const requests = requestStop({}, 'a', running)
		expect(isStopping(requests, 'a', running)).toBe(true)
		expect(isStopping(requests, 'b', running)).toBe(false)
	})

	it('end with the turn', () => {
		const requests = requestStop({}, 'a', running)
		expect(isStopping(requests, 'a', { running: false, turn: 3 })).toBe(false)
	})

	it('never carry over to the next reply', () => {
		const requests = requestStop({}, 'a', running)
		expect(isStopping(requests, 'a', { running: true, turn: 4 })).toBe(false)
	})

	it('record nothing for a reply that already ended', () => {
		const none = {}
		expect(requestStop(none, 'a', { running: false, turn: 3 })).toBe(none)
	})

	it('are forgotten when the request fails', () => {
		const requests = requestStop(requestStop({}, 'a', running), 'b', running)
		const after = clearStop(requests, 'a')
		expect(isStopping(after, 'a', running)).toBe(false)
		expect(isStopping(after, 'b', running)).toBe(true)
		expect(clearStop(after, 'missing')).toBe(after)
	})
})
