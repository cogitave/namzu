import { describe, expect, it } from 'vitest'
import { quickEntryReadyToSend } from './quick-entry-ready.js'

const ready = {
	savedChoicesLoading: false,
	attachmentsLoaded: true,
	hasModel: true,
	modelReady: true,
}

describe('the Quick Entry line waiting for a new conversation', () => {
	it('sends once everything a send needs is there', () => {
		expect(quickEntryReadyToSend(ready)).toBe(true)
	})

	it.each([
		['saved choices still loading', { savedChoicesLoading: true }],
		['attachments not loaded', { attachmentsLoaded: false }],
		['no model chosen yet', { hasModel: false }],
		['model not ready', { modelReady: false }],
	])('waits while %s', (_name, change) => {
		expect(quickEntryReadyToSend({ ...ready, ...change })).toBe(false)
	})
})
