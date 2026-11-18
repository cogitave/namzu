import { expect, it } from 'vitest'
import {
	acceleratorFromPress,
	dictationPressed,
	isAccelerator,
	isShortcutSetting,
} from './shortcuts.js'

const press = (
	code: string,
	held: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {},
) => ({
	code,
	ctrlKey: false,
	altKey: false,
	shiftKey: false,
	metaKey: false,
	...held,
})

it('accepts a key with a real modifier and nothing else', () => {
	expect(isAccelerator('Ctrl+Alt+Space')).toBe(true)
	expect(isAccelerator('Alt+F9')).toBe(true)
	expect(isAccelerator('Super+Shift+K')).toBe(true)
	expect(isAccelerator('Space')).toBe(false)
	expect(isAccelerator('Shift+A')).toBe(false)
	expect(isAccelerator('Ctrl+')).toBe(false)
	expect(isAccelerator('Ctrl+Ctrl+A')).toBe(false)
	expect(isAccelerator('Ctrl+Enter')).toBe(false)
	expect(isAccelerator('Ctrl+Hyper+A')).toBe(false)
	expect(isShortcutSetting('')).toBe(true)
	expect(isShortcutSetting(3)).toBe(false)
})

it('spells a key press in the stored form, by physical key', () => {
	expect(acceleratorFromPress(press('Space', { ctrlKey: true, altKey: true }))).toBe(
		'Ctrl+Alt+Space',
	)
	expect(acceleratorFromPress(press('KeyN', { metaKey: true, shiftKey: true }))).toBe(
		'Shift+Super+N',
	)
	expect(acceleratorFromPress(press('Digit5', { altKey: true }))).toBe('Alt+5')
	expect(acceleratorFromPress(press('ArrowUp', { ctrlKey: true }))).toBe('Ctrl+Up')
	expect(acceleratorFromPress(press('ControlLeft', { ctrlKey: true }))).toBeUndefined()
	expect(acceleratorFromPress(press('KeyA'))).toBeUndefined()
	expect(acceleratorFromPress(press('Escape', { ctrlKey: true }))).toBeUndefined()
})

it('matches the dictation choice and ignores key repeat', () => {
	expect(dictationPressed('ctrl-d', press('KeyD', { ctrlKey: true }))).toBe(true)
	expect(dictationPressed('ctrl-d', press('KeyD', { ctrlKey: true, shiftKey: true }))).toBe(false)
	expect(dictationPressed('ctrl-shift-d', press('KeyD', { ctrlKey: true, shiftKey: true }))).toBe(
		true,
	)
	expect(dictationPressed('off', press('KeyD', { ctrlKey: true }))).toBe(false)
	expect(dictationPressed('ctrl-d', { ...press('KeyD', { ctrlKey: true }), repeat: true })).toBe(
		false,
	)
	expect(dictationPressed('ctrl-d', press('KeyD', { ctrlKey: true, altKey: true }))).toBe(false)
})
