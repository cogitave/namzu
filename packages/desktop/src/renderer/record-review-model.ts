import type { RecordingReviewView } from '../shared/recording-protocol.js'

/**
 * What the review sheet says, as plain values so the words can be tested without a window.
 */

export const REVIEW_HINT =
	'Nothing has been sent. Read it, remove what you do not want, then press Send. It is kept for 10 minutes.'

export const NOTE_PLACEHOLDER = 'Add a note, for example: make this a weekly report skill'

export const NO_PICTURES_NOTE = 'No pictures will be sent.'
export const NO_VOICE_NOTE = 'No voice text will be sent.'

/** The line under the pictures: how many, and what removing does. */
export function picturesLine(view: Pick<RecordingReviewView, 'pictureCount'>): string {
	if (view.pictureCount === 0) return NO_PICTURES_NOTE
	return `${view.pictureCount} ${view.pictureCount === 1 ? 'picture' : 'pictures'}. At most 24 are sent; the rest are left out.`
}

export function hasVoiceText(view: Pick<RecordingReviewView, 'steps'>): boolean {
	return view.steps.some((step) => step.kind === 'say')
}

/** The notes the sheet shows for what the recording could not do. */
export function limitNotes(view: Pick<RecordingReviewView, 'controls'>): string[] {
	return view.controls
		? []
		: ['No program showed its controls, so this recording has pictures and the pointer only.']
}
