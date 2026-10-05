import { expect, it } from 'vitest'
import { ComputerHeldKeyboard } from './computer-held-keyboard.js'

const neutral = { ctrlKey: false, altKey: false, metaKey: false, shiftKey: false }
const first = 'first-keyboard-lifetime'
const second = 'second-keyboard-lifetime'

it('holds simultaneous movement keys, ignores repeat and releases the original physical key', () => {
	const keyboard = new ComputerHeldKeyboard(() => first)
	expect(keyboard.down({ ...neutral, key: 'w', code: 'KeyW' })).toEqual([
		{ type: 'key_down', key: 'w', keyboardId: first },
	])
	expect(keyboard.down({ ...neutral, key: 'w', code: 'KeyW' })).toEqual([])
	expect(keyboard.down({ ...neutral, key: 'd', code: 'KeyD' })).toEqual([
		{ type: 'key_down', key: 'd', keyboardId: first },
	])
	// A layout or modifier change between down and up cannot release a different key.
	expect(keyboard.up({ ...neutral, key: 'W', code: 'KeyW' })).toEqual([
		{ type: 'key_up', key: 'w', keyboardId: first },
	])
	expect(keyboard.up({ ...neutral, key: 'w', code: 'KeyW' })).toBeNull()
	expect(keyboard.release()).toEqual({ type: 'release_keys', keyboardId: first })
	expect(keyboard.up({ ...neutral, key: 'd', code: 'KeyD' })).toBeNull()
})

it('synchronizes modifiers present at focus and releases them separately from the key', () => {
	const keyboard = new ComputerHeldKeyboard(() => first)
	expect(
		keyboard.down({ ...neutral, key: 'R', code: 'KeyR', ctrlKey: true, shiftKey: true }),
	).toEqual([
		{ type: 'key_down', key: 'Control_L', keyboardId: first },
		{ type: 'key_down', key: 'Shift_L', keyboardId: first },
		{ type: 'key_down', key: 'r', keyboardId: first },
	])
	expect(keyboard.up({ ...neutral, key: 'r', code: 'KeyR', ctrlKey: true })).toEqual([
		{ type: 'key_up', key: 'r', keyboardId: first },
		{ type: 'key_up', key: 'Shift_L', keyboardId: first },
	])
	expect(keyboard.up({ ...neutral, key: 'Control', code: 'ControlLeft' })).toEqual([
		{ type: 'key_up', key: 'Control_L', keyboardId: first },
	])
})

it('retains one held keysym until all physical keys using it have been released', () => {
	const keyboard = new ComputerHeldKeyboard(() => first)
	expect(keyboard.down({ ...neutral, key: '0', code: 'Digit0' })).toHaveLength(1)
	expect(keyboard.down({ ...neutral, key: '0', code: 'Numpad0' })).toEqual([])
	expect(keyboard.up({ ...neutral, key: '0', code: 'Digit0' })).toEqual([])
	expect(keyboard.up({ ...neutral, key: '0', code: 'Numpad0' })).toEqual([
		{ type: 'key_up', key: '0', keyboardId: first },
	])
})

it('rotates ownership after cleanup, including a lifetime whose keys have already been released', () => {
	let index = 0
	const keyboard = new ComputerHeldKeyboard(() => [first, second][index++] ?? 'unexpected')
	keyboard.down({ ...neutral, key: 'ArrowUp', code: 'ArrowUp' })
	keyboard.up({ ...neutral, key: 'ArrowUp', code: 'ArrowUp' })
	expect(keyboard.release()).toEqual({ type: 'release_keys', keyboardId: first })
	expect(keyboard.release()).toBeNull()
	expect(keyboard.down({ ...neutral, key: ' ', code: 'Space' })).toEqual([
		{ type: 'key_down', key: 'space', keyboardId: second },
	])
})

it('preserves international text while keeping IME and Tab in the host focus flow', () => {
	const keyboard = new ComputerHeldKeyboard(() => first)
	for (const key of ['İ', 'ç', '🐰'])
		expect(keyboard.down({ ...neutral, key })).toEqual([{ type: 'type_text', text: key }])
	expect(
		keyboard.down({ ...neutral, key: '@', ctrlKey: true, altKey: true, altGraph: true }),
	).toEqual([{ type: 'type_text', text: '@' }])
	for (const key of ['Tab', 'Dead', 'Process'])
		expect(keyboard.down({ ...neutral, key })).toBeNull()
	expect(keyboard.down({ ...neutral, key: 'a', isComposing: true })).toBeNull()
	expect(keyboard.down({ ...neutral, key: 'AltGraph', altGraph: true })).toBeNull()
	expect(keyboard.down({ ...neutral, key: 'İ', ctrlKey: true })).toBeNull()
	expect(keyboard.release()).toBeNull()
})

it('keeps shifted punctuation on the complete text/shortcut port without claiming implicit Shift ownership', () => {
	const keyboard = new ComputerHeldKeyboard(() => first)
	keyboard.down({ ...neutral, key: 'Shift', code: 'ShiftLeft', shiftKey: true })
	expect(keyboard.down({ ...neutral, key: '+', code: 'Equal', shiftKey: true })).toEqual([
		{ type: 'type_text', text: '+' },
	])
	expect(keyboard.up({ ...neutral, key: '+', code: 'Equal', shiftKey: true })).toBeNull()
	expect(keyboard.down({ ...neutral, key: 'r', code: 'KeyR', shiftKey: true })).toEqual([
		{ type: 'key_down', key: 'r', keyboardId: first },
	])
	expect(
		keyboard.down({ ...neutral, key: '+', code: 'Equal', ctrlKey: true, shiftKey: true }),
	).toEqual([{ type: 'key', keys: 'CTRL+SHIFT+plus' }])
	expect(keyboard.release()).toEqual({ type: 'release_keys', keyboardId: first })
})
