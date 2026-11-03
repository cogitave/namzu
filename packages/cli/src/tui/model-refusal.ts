import { terminalDisplayText } from './terminal-display.js'

/**
 * The words for a model that declined to answer, in one place so the live row,
 * the settled stop line, a restored transcript and the thrown content-filter
 * error all say the same thing.
 */

/** The sentence every wording shares: it says the request was probably fine. */
export const DECLINED_AND_NORMAL =
	'declined to answer this message. This sometimes happens with safe, normal requests.'

/** What a person can do when nothing answered in the model's place. */
export const REFUSED_NEXT =
	'Press esc twice to edit your message, or pick another model with /model.'

export interface ModelRefusalFacts {
	readonly model: string
	readonly outcome: 'fallback' | 'retry' | 'declined'
	readonly fallbackModel?: string
	readonly category?: string
	readonly explanation?: string
}

function oneLine(value: string, max: number): string {
	const clean = terminalDisplayText(value).replace(/\s+/gu, ' ').trim()
	return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1))}…`
}

/** The plain row for a refusal and what the turn did about it. */
export function describeModelRefusal(facts: ModelRefusalFacts): string {
	const model = oneLine(facts.model, 120)
	switch (facts.outcome) {
		case 'fallback':
			return `${model} ${DECLINED_AND_NORMAL} ${oneLine(facts.fallbackModel ?? 'Another model', 120)} answered instead; /model switches back.`
		case 'retry':
			return `${model} stopped its reply to this message. This sometimes happens with safe, normal requests. Trying once more with that noted.`
		case 'declined':
			return `${model} ${DECLINED_AND_NORMAL} ${REFUSED_NEXT}`
	}
}

/**
 * The line a turn that settled `refused` ends with when no refusal row said
 * so (a restored transcript has the stop reason and nothing else).
 */
export const REFUSED_TURN_NOTICE = `The model ${DECLINED_AND_NORMAL} ${REFUSED_NEXT}`

/**
 * The provider's own category and sentence as one `Details:` line under the
 * row, or nothing when the provider said neither.
 */
export function refusalDetail(facts: {
	readonly category?: string
	readonly explanation?: string
}): readonly string[] {
	const parts = [
		facts.category ? oneLine(facts.category, 120) : '',
		facts.explanation ? oneLine(facts.explanation, 600) : '',
	].filter((part) => part.length > 0)
	return parts.length > 0 ? [`Details: ${parts.join(' · ')}`] : []
}

/** The same for a run nobody is watching: it cannot edit a message, so it says what to change. */
export const REFUSED_HEADLESS_NOTICE = `The model ${DECLINED_AND_NORMAL} Rephrase the request, or run it on another model.`
