import { describe, expect, it } from 'vitest'
import { NAMED_FAILURE_SENTENCES, namedFailure, namedFailureSentence } from './named-failures.js'

describe('named failures', () => {
	it('names each failure the log used to call unclassified, and gives it a plain sentence', () => {
		expect(namedFailure('Namzu returned an invalid undo status.')).toBe('undo-status-invalid')
		expect(namedFailure('boom', 'undoStatus')).toBe('undo-status-unavailable')
		expect(namedFailure('boom', 'namzu/turns/undo-status')).toBe('undo-status-unavailable')
		expect(namedFailure('boom', 'draftSettings')).toBe('settings-unavailable')
		expect(namedFailure('boom', 'modelSettings')).toBe('settings-unavailable')
		expect(namedFailure('The provider is not configured.', 'modelSettings')).toBe(
			'provider-not-configured',
		)
		expect(namedFailure('boom', 'namzu/providers/settings')).toBe('provider-setup-unavailable')
		for (const sentence of Object.values(NAMED_FAILURE_SENTENCES))
			expect(sentence).toMatch(/^[A-Z].*\.$/)
	})
	it('leaves any other read unnamed', () => {
		expect(namedFailure('boom', 'send')).toBeUndefined()
		expect(namedFailureSentence('boom')).toBeUndefined()
	})
	it('maps a reason to its sentence', () => {
		expect(namedFailureSentence('boom', 'undoStatus')).toBe(
			NAMED_FAILURE_SENTENCES['undo-status-unavailable'],
		)
	})
	it('promises no retry in the undo sentence, since a second failure is not retried', () => {
		expect(NAMED_FAILURE_SENTENCES['undo-status-unavailable']).not.toMatch(
			/once more|again|comes back/i,
		)
	})
})
