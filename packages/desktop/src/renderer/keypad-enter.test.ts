import { expect, it, vi } from 'vitest'
import { installKeypadEnter, pressButtonWithKeypadEnter } from './keypad-enter.js'

const event = (over: Record<string, unknown> = {}) => {
	const click = vi.fn()
	const preventDefault = vi.fn()
	return {
		click,
		preventDefault,
		event: {
			code: 'NumpadEnter',
			key: 'Enter',
			defaultPrevented: false,
			altKey: false,
			ctrlKey: false,
			metaKey: false,
			shiftKey: false,
			target: { tagName: 'BUTTON', disabled: false, click },
			preventDefault,
			...over,
		},
	}
}

it('presses a focused button with the number pad’s Enter, once', () => {
	const { event: e, click, preventDefault } = event()
	expect(pressButtonWithKeypadEnter(e)).toBe(true)
	expect(click).toHaveBeenCalledOnce()
	expect(preventDefault).toHaveBeenCalledOnce()
})

it('leaves the main Enter, a disabled button, other elements, modifiers and handled keys alone', () => {
	for (const over of [
		{ code: 'Enter' },
		{ target: { tagName: 'BUTTON', disabled: true, click: vi.fn() } },
		{ target: { tagName: 'TEXTAREA', click: vi.fn() } },
		{ ctrlKey: true },
		{ defaultPrevented: true },
		{ isComposing: true },
	]) {
		const { event: e, click } = event(over)
		expect(pressButtonWithKeypadEnter(e)).toBe(false)
		expect(click).not.toHaveBeenCalled()
	}
})

it('listens at the capture phase and can be removed', () => {
	const add = vi.fn()
	const remove = vi.fn()
	const undo = installKeypadEnter({ addEventListener: add, removeEventListener: remove })
	expect(add).toHaveBeenCalledWith('keydown', expect.any(Function), true)
	undo()
	expect(remove).toHaveBeenCalledWith('keydown', add.mock.calls[0]?.[1], true)
})
