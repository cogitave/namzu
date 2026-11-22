import { describe, expect, it, vi } from 'vitest'

import { createComputerUseLive } from './computer-use-live.js'

function setup(initial = false) {
	const state = { on: initial, failNext: false }
	const start = vi.fn(async () => {
		if (state.failNext) throw new Error('desktop did not answer')
	})
	const live = createComputerUseLive({ read: () => state.on, start })
	return { state, start, live }
}

describe('computer use live switch', () => {
	it('does not start the host while the setting is off', async () => {
		const { start, live } = setup(false)
		await live.refresh()
		expect(start).not.toHaveBeenCalled()
		expect(live.ready()).toBe(false)
	})

	it('starts the host exactly once on the first flip to on', async () => {
		const { state, start, live } = setup(false)
		await live.refresh()
		state.on = true
		await live.refresh()
		await live.refresh()
		expect(start).toHaveBeenCalledTimes(1)
		expect(live.ready()).toBe(true)
	})

	it('is not ready the moment it is turned off, and a repeat flip to on does not start it again', async () => {
		const { state, start, live } = setup(true)
		await live.refresh()
		expect(live.ready()).toBe(true)
		live.notify(false)
		expect(live.ready()).toBe(false)
		state.on = false
		await live.refresh()
		state.on = true
		await live.refresh()
		expect(live.ready()).toBe(true)
		expect(start).toHaveBeenCalledTimes(1)
	})

	it('takes the value a write reported without reading, once', async () => {
		const read = vi.fn(() => false)
		const start = vi.fn(async () => {})
		const live = createComputerUseLive({ read, start })
		live.notify(true)
		await live.refresh()
		expect(read).not.toHaveBeenCalled()
		expect(live.ready()).toBe(true)
		await live.refresh()
		expect(read).toHaveBeenCalledTimes(1)
		expect(live.ready()).toBe(false)
	})

	it('stays suspended with the reason after a failed start and retries once after off and on', async () => {
		const { state, start, live } = setup(true)
		state.failNext = true
		await live.refresh()
		expect(live.state).toBe('failed')
		expect(live.failure?.message).toBe('desktop did not answer')
		expect(live.ready()).toBe(false)
		await live.refresh()
		await live.refresh()
		expect(start).toHaveBeenCalledTimes(1)

		state.on = false
		await live.refresh()
		state.failNext = false
		state.on = true
		await live.refresh()
		expect(start).toHaveBeenCalledTimes(2)
		expect(live.ready()).toBe(true)
		expect(live.failure).toBeUndefined()
	})

	it('counts as off when the setting cannot be read', async () => {
		let broken = false
		const live = createComputerUseLive({
			read: () => {
				if (broken) throw new Error('half-written file')
				return true
			},
			start: async () => {},
		})
		await live.refresh()
		broken = true
		await live.refresh()
		expect(live.ready()).toBe(false)
	})

	it('shares one start between two refreshes that overlap', async () => {
		let release: (() => void) | undefined
		const start = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve
				}),
		)
		const live = createComputerUseLive({ read: () => true, start })
		const first = live.refresh()
		const second = live.refresh()
		release?.()
		await Promise.all([first, second])
		expect(start).toHaveBeenCalledTimes(1)
		expect(live.ready()).toBe(true)
	})
})
