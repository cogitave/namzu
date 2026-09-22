/**
 * The notice layer drops a system notice identical to the row just before it.
 *
 * The owner saw "Permissions were not changed. Finish or stop the current
 * work first." on two consecutive lines after pressing a key twice. The
 * dedupe belongs to the notice layer so no caller has to remember it, and it
 * is narrow on purpose: only system rows, only exact repeats, only against
 * the last row.
 */

import { describe, expect, it } from 'vitest'

import { isRepeatedNotice } from '../notices.js'
import type { TranscriptMessage } from '../types.js'

const notice = (content: string, extra: Partial<TranscriptMessage> = {}): TranscriptMessage => ({
	id: 'n1',
	role: 'system',
	content,
	...extra,
})

const SAID = 'Choose a model before changing permissions.'

describe('isRepeatedNotice', () => {
	it('drops an identical system notice that directly follows itself', () => {
		expect(isRepeatedNotice(notice(SAID), { role: 'system', content: SAID })).toBe(true)
	})

	it('keeps it when anything else came in between, or when it differs', () => {
		expect(isRepeatedNotice(undefined, { role: 'system', content: SAID })).toBe(false)
		expect(
			isRepeatedNotice(
				{ id: 'r', role: 'assistant', content: 'ok' },
				{ role: 'system', content: SAID },
			),
		).toBe(false)
		expect(isRepeatedNotice(notice(SAID), { role: 'system', content: `${SAID} ` })).toBe(false)
		expect(isRepeatedNotice(notice(SAID, { glyph: '!' }), { role: 'system', content: SAID })).toBe(
			false,
		)
	})

	it('never edits the model or a tool: only system rows are compared', () => {
		const tool: TranscriptMessage = { id: 't', role: 'tool', content: 'Ran ls' }
		expect(isRepeatedNotice(tool, { role: 'tool', content: 'Ran ls' })).toBe(false)
		const reply: TranscriptMessage = { id: 'a', role: 'assistant', content: 'Yes.' }
		expect(isRepeatedNotice(reply, { role: 'assistant', content: 'Yes.' })).toBe(false)
	})

	it('keeps a notice with a body, a pending row, or a live panel', () => {
		expect(
			isRepeatedNotice(notice(SAID, { detail: ['x'] }), { role: 'system', content: SAID }),
		).toBe(false)
		expect(isRepeatedNotice(notice(SAID), { role: 'system', content: SAID, detail: ['x'] })).toBe(
			false,
		)
		expect(
			isRepeatedNotice(notice(SAID, { pending: true }), { role: 'system', content: SAID }),
		).toBe(false)
		expect(isRepeatedNotice(notice(SAID), { role: 'system', content: SAID, pending: true })).toBe(
			false,
		)
	})
})
