import { describe, expect, it } from 'vitest'
import { savedPresentation } from './saved-presentation.js'

describe('savedPresentation', () => {
	it('keeps the live label and its flags, never the output', () => {
		expect(
			savedPresentation(
				{},
				{
					kind: 'generic',
					label: 'Search x in d\nmore',
					presentation: 'activity',
					activity: 'exploration',
				},
				{ kind: 'generic', label: 'ignored', visibility: 'hidden' },
			),
		).toEqual({
			kind: 'generic',
			label: 'Search x in d',
			presentation: 'activity',
			activity: 'exploration',
			visibility: 'hidden',
		})
	})

	it('keeps the first line of a command for a tool with no view of its own', () => {
		expect(savedPresentation({ command: 'make\nmore' }, undefined, undefined)).toEqual({
			kind: 'terminal',
			command: 'make',
			output: '',
		})
	})

	it('keeps a terminal result as its command only', () => {
		expect(
			savedPresentation({}, undefined, { kind: 'terminal', command: 'ls', output: 'big' }),
		).toEqual({ kind: 'terminal', command: 'ls', output: '' })
	})

	it('falls back to the generic primary argument and bounds it', () => {
		const view = savedPresentation({ description: 'd'.repeat(400) }, undefined, undefined)
		expect(view?.kind === 'generic' && Array.from(view.label).length).toBe(200)
	})

	it('saves nothing for a diff, an argument dump or a blank label', () => {
		expect(
			savedPresentation({}, undefined, { kind: 'diff', before: '', after: 'x' }),
		).toBeUndefined()
		expect(savedPresentation({ blob: 1 }, undefined, undefined)).toBeUndefined()
		expect(savedPresentation({}, { kind: 'generic', label: ' ' }, undefined)).toBeUndefined()
	})
})
