import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { RecordingReviewView } from '../shared/recording-protocol.js'
import { REVIEW_HINT, hasVoiceText, limitNotes, picturesLine } from './record-review-model.js'
import { RecordingReview } from './record-review.js'

const view: RecordingReviewView = {
	id: 'r',
	durationMs: 192_000,
	duration: '3:12',
	pictureCount: 2,
	stepCount: 2,
	voice: 'on',
	controls: true,
	steps: [
		{ id: 1, t: 500, time: '0:00', label: 'Switched to Spreadsheet', kind: 'app' },
		{ id: 4, t: 6200, time: '0:06', label: 'Said “now I filter”', kind: 'say' },
	],
	pictures: [
		{ index: 1, time: '0:00', thumb: 'data:image/jpeg;base64,AAAA' },
		{ index: 2, time: '0:06', thumb: 'data:image/jpeg;base64,BBBB' },
	],
	cutLines: ['You removed 1 step.'],
	holdMs: 600_000,
	summary: 'Recording ready: 3:12, 2 pictures, 2 steps, voice on',
}

const draw = () =>
	renderToStaticMarkup(
		createElement(RecordingReview, {
			view,
			onEdit: () => undefined,
			onSend: async () => undefined,
			onDiscard: () => undefined,
		}),
	)

it('says what was recorded, that nothing was sent, and offers Send and Discard', () => {
	const html = draw()
	expect(html).toContain('Recording ready: 3:12, 2 pictures, 2 steps, voice on')
	expect(html).toContain(REVIEW_HINT.replace(/'/g, '&#x27;'))
	expect(html).toContain('data-action="send"')
	expect(html).toContain('data-action="discard"')
	expect(html).toContain('>View<')
	// The note field is the person's own words, which travel with the recording.
	expect(html).toContain('aria-label="Your note for this recording"')
})

it('keeps the steps and pictures behind View, so the sheet starts small', () => {
	const html = draw()
	expect(html).not.toContain('recording-review-steps')
	expect(html).not.toContain('Remove pictures')
})

it('counts pictures and says when none will be sent', () => {
	expect(picturesLine(view)).toBe('2 pictures. At most 24 are sent; the rest are left out.')
	expect(picturesLine({ pictureCount: 1 })).toContain('1 picture.')
	expect(picturesLine({ pictureCount: 0 })).toBe('No pictures will be sent.')
})

it('knows when there is voice text to remove', () => {
	expect(hasVoiceText(view)).toBe(true)
	expect(hasVoiceText({ steps: [] })).toBe(false)
})

it('says so when no program showed its controls', () => {
	expect(limitNotes({ controls: true })).toEqual([])
	expect(limitNotes({ controls: false })[0]).toContain('pictures and the pointer only')
})
