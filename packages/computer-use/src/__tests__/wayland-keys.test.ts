import { describe, expect, it } from 'vitest'
import { translateKeyToYdotool } from '../adapters/linux-wayland.js'

describe('translateKeyToYdotool', () => {
	it('emits press/release pairs for a bare key', () => {
		expect(translateKeyToYdotool('Return')).toBe('KEY_ENTER:1 KEY_ENTER:0')
		expect(translateKeyToYdotool('a')).toBe('KEY_A:1 KEY_A:0')
	})

	it('wraps modifiers around the main key for combos', () => {
		expect(translateKeyToYdotool('ctrl+c')).toBe('KEY_LEFTCTRL:1 KEY_C:1 KEY_C:0 KEY_LEFTCTRL:0')
		expect(translateKeyToYdotool('ctrl+shift+t')).toBe(
			'KEY_LEFTCTRL:1 KEY_LEFTSHIFT:1 KEY_T:1 KEY_T:0 KEY_LEFTSHIFT:0 KEY_LEFTCTRL:0',
		)
	})

	it('normalises modifier aliases', () => {
		expect(translateKeyToYdotool('cmd+c')).toBe('KEY_LEFTMETA:1 KEY_C:1 KEY_C:0 KEY_LEFTMETA:0')
		expect(translateKeyToYdotool('alt+Tab')).toBe('KEY_LEFTALT:1 KEY_TAB:1 KEY_TAB:0 KEY_LEFTALT:0')
	})

	it('maps named special keys', () => {
		expect(translateKeyToYdotool('escape')).toBe('KEY_ESC:1 KEY_ESC:0')
		expect(translateKeyToYdotool('backspace')).toBe('KEY_BACKSPACE:1 KEY_BACKSPACE:0')
		expect(translateKeyToYdotool('page_up')).toBe('KEY_PAGEUP:1 KEY_PAGEUP:0')
	})
})
