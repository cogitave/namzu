import { describe, expect, it } from 'vitest'
import { _translateKeyCombo as translateKeyCombo } from '../adapters/linux-x11.js'

describe('translateKeyCombo (xdotool)', () => {
	it('maps single keys to xdotool names', () => {
		expect(translateKeyCombo('Return')).toBe('Return')
		expect(translateKeyCombo('escape')).toBe('Escape')
		expect(translateKeyCombo('enter')).toBe('Return')
		expect(translateKeyCombo('backspace')).toBe('BackSpace')
		expect(translateKeyCombo('page_up')).toBe('Page_Up')
		expect(translateKeyCombo('up')).toBe('Up')
	})

	it('normalises modifier aliases to xdotool equivalents', () => {
		expect(translateKeyCombo('cmd+c')).toBe('super+c')
		expect(translateKeyCombo('meta+c')).toBe('super+c')
		expect(translateKeyCombo('ctrl+v')).toBe('ctrl+v')
		expect(translateKeyCombo('Control+v')).toBe('ctrl+v')
		expect(translateKeyCombo('alt+Tab')).toBe('alt+Tab')
		expect(translateKeyCombo('option+Tab')).toBe('alt+Tab')
	})

	it('preserves unknown tokens as-is for xdotool to try', () => {
		expect(translateKeyCombo('F5')).toBe('F5')
		expect(translateKeyCombo('ctrl+shift+F12')).toBe('ctrl+shift+F12')
	})
})
