import { describe, expect, it } from 'vitest'
import { acceleratorLabel, guessChromePlatform } from './window-menu-labels.js'

describe('window menu labels', () => {
	it('writes a shortcut as the platform shows it', () => {
		expect(acceleratorLabel('CmdOrCtrl+Z', false)).toBe('Ctrl+Z')
		expect(acceleratorLabel('CmdOrCtrl+Shift+Z', false)).toBe('Ctrl+Shift+Z')
		expect(acceleratorLabel('CmdOrCtrl+Shift+Z', true)).toBe('⇧⌘Z')
		expect(acceleratorLabel('F11', false)).toBe('F11')
		expect(acceleratorLabel('Ctrl+Alt+i', false)).toBe('Ctrl+Alt+I')
	})
	it('guesses the platform for the first frame from the browser string', () => {
		expect(guessChromePlatform('MacIntel')).toBe('darwin')
		expect(guessChromePlatform('Win32')).toBe('win32')
		expect(guessChromePlatform('Linux x86_64')).toBe('linux')
		expect(guessChromePlatform('')).toBe('other')
	})
})
