import { describe, expect, it } from 'vitest'
import { endSentence, stripLeadingComments } from './disclosure.js'

describe('disclosure: the storage phrases read as sentences', () => {
	it('adds a full stop only where the phrase has none', () => {
		expect(endSentence('This computer, in its own data folder')).toBe(
			'This computer, in its own data folder.',
		)
		expect(endSentence('Sealed to your user.')).toBe('Sealed to your user.')
		expect(endSentence('  Sealed (test build)  ')).toBe('Sealed (test build).')
	})

	it('leaves out every comment line a notice file opens with, and only those', () => {
		const opened = '<!-- locale: tr -->\n<!-- DRAFT: x -->\n# Title\ntext <!-- kept -->'
		expect(stripLeadingComments(opened)).toBe('# Title\ntext <!-- kept -->')
		expect(stripLeadingComments('# Title')).toBe('# Title')
	})
})
