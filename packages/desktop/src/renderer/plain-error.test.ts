import { describe, expect, it } from 'vitest'
import { cleanErrorMessage, ensurePlain, isPlainMessage, plainError } from './plain-error.js'

const RAW = [
	"Error invoking remote method 'namzu:renameProject': Error: ENOENT: no such file or directory, open '/x/y'",
	'SupersededConversationSettingsError: The conversation settings changed while loading.',
	"TypeError: Cannot read properties of undefined (reading 'id')\n    at Object.run (/app/main.js:10:5)",
	'Namzu returned an oversized protocol frame.',
	'Invalid workspace action.',
	'Namzu exited while descendants retained its protocol pipes.',
	'Local speech cleanup ownership check failed.',
	'Speech ended before playback acknowledged audio.',
	'Could not stop the owned Namzu process tree.',
	'EPERM: operation not permitted, unlink C:\\Users\\a\\x',
	'[object Object]',
	'undefined',
]

describe('plainError', () => {
	it.each(RAW)('never shows %j', (raw) => {
		const { text } = plainError(new Error(raw), 'rename the project')
		expect(text).not.toMatch(/Error invoking remote method|[A-Za-z]+Error\b|ENOENT|EPERM|EACCES/)
		expect(text).not.toMatch(
			/\n\s+at\s|undefined|\[object|protocol|frame|pipes|descendants|ownership/,
		)
		expect(text).toMatch(/[.!?]$/)
		expect(text.length).toBeLessThan(160)
	})

	it('maps a developer sentence to the action that failed and keeps the original behind Details', () => {
		expect(plainError(new Error('Invalid terminal tab.'), 'close the terminal')).toMatchObject({
			text: 'Namzu ran into a problem and stopped that. Try again, or restart Namzu if it keeps happening.',
			details: 'Invalid terminal tab.',
		})
		expect(plainError(new Error('boom_happened'), 'rename the project')).toEqual({
			text: 'Couldn’t rename the project. Try again.',
			details: 'boom_happened',
		})
	})

	it('turns operating-system codes into a sentence with a next step', () => {
		expect(
			plainError(new Error("Error invoking remote method 'x': Error: ENOENT: no such file")).text,
		).toBe('That file or folder no longer exists. Choose another one.')
		expect(plainError(new Error('EACCES: permission denied, open /x')).text).toMatch(
			/isn’t allowed to open that/,
		)
	})

	it('lets a sentence the product wrote through, including a quoted file name', () => {
		expect(plainError(new Error('Stop this conversation before changing its model.')).text).toBe(
			'Stop this conversation before changing its model.',
		)
		const named = '“quarterly_report.pdf” can’t be attached. Namzu reads images and text files.'
		expect(plainError(new Error(named))).toEqual({ text: named })
	})

	it('has a sentence for a value that is not an Error', () => {
		expect(plainError(undefined, 'open the folder').text).toBe(
			'Couldn’t open the folder. Try again.',
		)
		expect(plainError({ code: 1 }).text).toBe('That didn’t work. Try again.')
	})
})

describe('cleanErrorMessage', () => {
	it('drops Electron’s prefix, class names and stacks', () => {
		expect(
			cleanErrorMessage("Error invoking remote method 'a:b': TypeError: nope\n    at x (y:1:2)"),
		).toBe('nope')
	})
})

describe('ensurePlain', () => {
	it('leaves a built sentence alone and cleans a raw one', () => {
		expect(ensurePlain('Namzu is reconnecting.')).toEqual({ text: 'Namzu is reconnecting.' })
		expect(ensurePlain('Error: ENOENT: no such file').text).not.toMatch(/ENOENT|Error:/)
	})
})

describe('isPlainMessage', () => {
	it('rejects codes, class names and snake_case', () => {
		expect(isPlainMessage('Every file is fine.')).toBe(true)
		expect(isPlainMessage('Failed with ERR_INVALID_ARG_TYPE.')).toBe(false)
		expect(isPlainMessage('The value was undefined here.')).toBe(false)
		expect(isPlainMessage('no capital and no stop')).toBe(false)
	})
})
