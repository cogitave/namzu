import { expect, it } from 'vitest'
import { isOvertakenRead } from './overtaken-read.js'

it('tells a read a model change overtook from a real failure', () => {
	expect(
		isOvertakenRead(
			new Error('The conversation settings changed while loading. Retry this request.'),
		),
	).toBe(true)
	expect(
		isOvertakenRead(
			new Error(
				'SupersededConversationSettingsError: The conversation settings changed while loading. Retry this request.',
			),
		),
	).toBe(true)
	expect(isOvertakenRead(new Error('Namzu could not start.'))).toBe(false)
	expect(isOvertakenRead(undefined)).toBe(false)
})
