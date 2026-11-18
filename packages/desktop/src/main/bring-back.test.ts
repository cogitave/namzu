import { describe, expect, it } from 'vitest'
import { BringBack, type RaiseWindow } from './bring-back.js'

function fake(state: Partial<{ focused: boolean; minimized: boolean; visible: boolean }> = {}) {
	const calls: string[] = []
	const window: RaiseWindow & { state: typeof state } = {
		state,
		isDestroyed: () => false,
		isFocused: () => state.focused === true,
		isMinimized: () => state.minimized === true,
		isVisible: () => state.visible !== false,
		moveTop: () => calls.push('top'),
		flashFrame: (flash) => calls.push(`flash:${flash}`),
	}
	return { window, calls }
}

describe('bringing Namzu back', () => {
	it('moves a covered window up without focus and flashes it once', () => {
		const { window, calls } = fake()
		const back = new BringBack(() => [window])
		expect(back.needed()).toBe(true)
		expect(calls).toEqual(['top', 'flash:true'])
		// Once per wait: asking again does nothing.
		expect(back.needed()).toBe(false)
		expect(calls).toEqual(['top', 'flash:true'])
	})

	it('does nothing while a Namzu window is focused', () => {
		const { window, calls } = fake({ focused: true })
		expect(new BringBack(() => [window]).needed()).toBe(false)
		expect(calls).toEqual([])
	})

	it('only flashes a minimised window, so it does not jump over what the person is using', () => {
		const { window, calls } = fake({ minimized: true })
		new BringBack(() => [window]).needed()
		expect(calls).toEqual(['flash:true'])
	})

	it('arms again once the person has the window, and lets go of the flash', () => {
		const { window, calls } = fake()
		const back = new BringBack(() => [window])
		back.needed()
		back.focused()
		expect(calls.at(-1)).toBe('flash:false')
		expect(back.needed()).toBe(true)
	})

	it('has nothing to do without a window', () => {
		expect(new BringBack(() => []).needed()).toBe(false)
	})
})
