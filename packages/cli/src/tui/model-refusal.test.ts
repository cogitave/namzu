import { describe, expect, it } from 'vitest'

import {
	REFUSED_HEADLESS_NOTICE,
	REFUSED_TURN_NOTICE,
	describeModelRefusal,
	refusalDetail,
} from './model-refusal.js'

const FORBIDDEN = /new session|session id|request id|message id|[0-9a-f]{8}-[0-9a-f]{4}/i

describe('the words for a model that declined', () => {
	it('names the model that answered instead and how to switch back', () => {
		const text = describeModelRefusal({
			model: 'claude-sonnet-5-5',
			outcome: 'fallback',
			fallbackModel: 'claude-opus-5-5',
		})
		expect(text).toBe(
			'claude-sonnet-5-5 declined to answer this message. This sometimes happens with safe, normal requests. claude-opus-5-5 answered instead; /model switches back.',
		)
		expect(text).not.toMatch(FORBIDDEN)
	})

	it('without another model, says how to edit the message or pick a model', () => {
		const text = describeModelRefusal({ model: 'claude-sonnet-5-5', outcome: 'declined' })
		expect(text).toBe(
			'claude-sonnet-5-5 declined to answer this message. This sometimes happens with safe, normal requests. Press esc twice to edit your message, or pick another model with /model.',
		)
		expect(text).not.toMatch(FORBIDDEN)
	})

	it('says a same-model retry is happening, without claiming another model answered', () => {
		const text = describeModelRefusal({ model: 'm', outcome: 'retry' })
		expect(text).toMatch(/stopped its reply/)
		expect(text).not.toMatch(/answered instead|new session/)
	})

	it('keeps control characters out of a model name', () => {
		const text = describeModelRefusal({ model: 'bad\u001b[31mname\nline', outcome: 'declined' })
		expect(text.includes(String.fromCharCode(27))).toBe(false)
		expect(text.includes('\n')).toBe(false)
	})

	it('puts the provider words on one Details line, or nothing when it said none', () => {
		expect(refusalDetail({ category: 'cyber', explanation: 'flagged' })).toEqual([
			'Details: cyber · flagged',
		])
		expect(refusalDetail({ explanation: 'flagged' })).toEqual(['Details: flagged'])
		expect(refusalDetail({})).toEqual([])
	})

	it('has a restored-transcript line and a headless line that never say start a new session', () => {
		for (const line of [REFUSED_TURN_NOTICE, REFUSED_HEADLESS_NOTICE]) {
			expect(line).toMatch(/declined to answer this message/)
			expect(line).not.toMatch(/new session/i)
		}
	})
})
