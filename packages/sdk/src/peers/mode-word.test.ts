import { expect, it } from 'vitest'
import { permissionModeWord } from './mode-word.js'

it('names a permission mode the way the screen does, and leaves other words alone', () => {
	expect(permissionModeWord('classify')).toBe('auto')
	expect(permissionModeWord('auto')).toBe('unattended')
	for (const word of ['prompt', 'plan', 'bypass', 'accept-edits', 'strict', 'net', 'whatever'])
		expect(permissionModeWord(word)).toBe(word)
})
