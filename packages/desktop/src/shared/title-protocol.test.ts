import { describe, expect, it } from 'vitest'
import { TITLE_MAX, TITLE_NOTIFICATION, readTitleNotice } from './title-protocol.js'

describe('the title notification', () => {
	it('keeps the recorded name', () => {
		expect(TITLE_NOTIFICATION).toBe('namzu/session/title')
	})
	it('reads one clean line', () => {
		expect(readTitleNotice({ sessionId: 's', title: '  Ada Kahve\n sayfası ' })).toEqual({
			sessionId: 's',
			title: 'Ada Kahve sayfası',
		})
	})
	it('refuses what does not read', () => {
		expect(readTitleNotice(null)).toBeUndefined()
		expect(readTitleNotice({ title: 'x' })).toBeUndefined()
		expect(readTitleNotice({ sessionId: 's', title: '   ' })).toBeUndefined()
		expect(readTitleNotice({ sessionId: 's', title: 'x'.repeat(TITLE_MAX + 1) })).toBeUndefined()
		expect(readTitleNotice({ sessionId: 's', title: 4 })).toBeUndefined()
	})
})
