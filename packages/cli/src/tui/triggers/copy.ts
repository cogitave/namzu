/**
 * The words the tag row says, at every width.
 *
 * Meaning is carried by words, never by colour or glyph alone: `✦` marks an
 * armed trigger and `✧` anything else, but the state is also always a word
 * or a mark — `?` for a suggestion, `(off)` for one dropped with Alt+W,
 * `unavailable …` for one that cannot apply. Both glyphs are one cell wide
 * and neither is an emoji. One row at every width; the text shortens by
 * steps before it is cut.
 */

import type { Detection, TriggerHit } from './detect.js'
import type { TriggerId } from './registry.js'

export const ARMED_MARK = '✦'
export const OTHER_MARK = '✧'

export interface TagCopyContext {
	/** Columns the row may use. */
	readonly columns: number
	/** A turn is running, so Enter steers into it. */
	readonly turnActive: boolean
	/** The model's highest published effort level, when it publishes a menu (max effort). */
	readonly highestEffort: string | undefined
	/** The level hypermode pins on this model (`xhigh`, or the nearest below it). */
	readonly hypermodeEffort: string | undefined
	/** No paste chips and no attachments: a trigger-only message may run its command. */
	readonly standaloneAllowed: boolean
}

/** Turn-scoped triggers apply only to a new turn: Enter mid-turn steers without them. */
const TURN_SCOPED: ReadonlySet<TriggerId> = new Set(['hypermode', 'schedule', 'max-effort'])

export function tagRow(detection: Detection, context: TagCopyContext): string | null {
	if (detection.paused) return fit(`${OTHER_MARK} triggers paused: draft too long`, context.columns)
	const hits = detection.hits
	if (hits.length === 0) return null
	const [only] = hits
	if (hits.length === 1 && only) return fit(single(only, detection, context), context.columns)
	return fit(several(hits, context), context.columns)
}

function single(hit: TriggerHit, detection: Detection, context: TagCopyContext): string {
	const { columns } = context
	switch (hit.state) {
		case 'suggested':
			if (hit.id === 'schedule' && columns >= 80)
				return `${OTHER_MARK} schedule? · alt+w: the agent proposes a job; you confirm it on screen`
			return columns >= 40
				? `${OTHER_MARK} ${hit.label}? · alt+w arms`
				: `${OTHER_MARK} ${hit.label}?`
		case 'dropped':
			if (columns >= 60) return `${OTHER_MARK} ${hit.label} (off) · alt+w restores`
			return `${OTHER_MARK} ${hit.label} (off)`
		case 'unavailable':
			return `${OTHER_MARK} ${hit.label} · ${hit.reason ?? 'unavailable'}`
		case 'armed':
			return armed(hit, detection, context)
	}
}

function armed(hit: TriggerHit, detection: Detection, context: TagCopyContext): string {
	const { columns, turnActive } = context
	const label = `${ARMED_MARK} ${hit.label}`
	if (columns < 40) return label
	const pinned = hit.id === 'hypermode' ? context.hypermodeEffort : context.highestEffort
	const effort = pinned ? `effort ${pinned}` : undefined
	const detail = ((): { full: string; short: string; tiny?: string } => {
		if (turnActive && TURN_SCOPED.has(hit.id))
			return {
				full: 'enter steers without it · tab: new turn with it',
				short: 'tab: new turn with it',
			}
		switch (hit.id) {
			case 'hypermode':
				if (detection.onlyTriggers)
					return { full: 'type the task in the same message', short: 'add the task' }
				return {
					full: `this turn: ${effort ? `${effort}, ` : ''}delegate to parallel agents`,
					short: `this turn${effort ? `, ${effort}` : ''}`,
					...(effort ? { tiny: effort } : {}),
				}
			case 'save-skill':
				if (detection.onlyTriggers && context.standaloneAllowed)
					return turnActive
						? { full: 'runs /skills save after the running turn', short: 'runs /skills save' }
						: { full: 'runs /skills save', short: 'runs /skills save' }
				if (turnActive)
					return {
						full: 'enter: after the running turn · tab: after the next',
						short: 'after the running turn',
					}
				return {
					full: 'after this turn, if it did work; you confirm the file',
					short: 'after this turn',
				}
			case 'schedule':
				return {
					full: 'the agent proposes a job; you confirm it on screen',
					short: 'the agent proposes a job',
				}
			case 'max-effort':
				return {
					full: `this turn: ${effort ?? 'effort as is'}`,
					short: `this turn${effort ? `, ${effort}` : ''}`,
					...(effort ? { tiny: effort } : {}),
				}
		}
	})()
	if (columns >= 80) return `${label} · ${detail.full} · alt+w drop`
	if (columns >= 60) return `${label} · ${detail.short} · alt+w`
	return detail.tiny ? `${label} · ${detail.tiny} · alt+w` : `${label} · alt+w`
}

function several(hits: readonly TriggerHit[], context: TagCopyContext): string {
	const { columns, hypermodeEffort } = context
	const armedCount = hits.filter((hit) => hit.state === 'armed').length
	const offCount = hits.filter((hit) => hit.state === 'dropped').length
	const key = armedCount > 0 ? 'alt+w drop' : offCount > 0 ? 'alt+w restores' : 'alt+w arms'
	if (columns < 60) {
		const counts = [
			armedCount > 0 ? `${armedCount} armed` : undefined,
			offCount > 0 ? `${offCount} off` : undefined,
			hits.length - armedCount - offCount > 0
				? `${hits.length - armedCount - offCount} more?`
				: undefined,
		]
			.filter(Boolean)
			.join(' · ')
		const mark = armedCount > 0 ? ARMED_MARK : OTHER_MARK
		return columns >= 40 ? `${mark} ${counts} · alt+w` : `${mark} ${counts}`
	}
	const parts = hits.map((hit) => {
		switch (hit.state) {
			case 'armed':
				// The effort pin is said wherever hypermode is armed.
				return hit.id === 'hypermode' && hypermodeEffort
					? `${ARMED_MARK} hypermode (effort ${hypermodeEffort})`
					: `${ARMED_MARK} ${hit.label}`
			case 'suggested':
				return `${OTHER_MARK} ${hit.label}?`
			case 'dropped':
				return `${OTHER_MARK} ${hit.label} (off)`
			case 'unavailable':
				return `${OTHER_MARK} ${hit.label} (unavailable)`
		}
	})
	return `${parts.join(' · ')} · ${columns >= 80 ? key : 'alt+w'}`
}

/** Cut to `columns` with an ellipsis; the row is always one line. */
function fit(text: string, columns: number): string {
	const cells = [...text]
	if (cells.length <= columns) return text
	return `${cells.slice(0, Math.max(0, columns - 1)).join('')}…`
}

/**
 * The line under the operator's row in the transcript, naming what the
 * message carried: `hypermode (this turn, effort xhigh)`. The row's own
 * glyph is the `✦`. Undefined when nothing applies.
 */
export function transcriptTagLine(
	ids: readonly TriggerId[],
	context: {
		/** The effort the turn was pinned to, when a trigger pinned one. */
		readonly effort: string | undefined
		readonly steered: boolean
	},
): string | undefined {
	const effort = context.effort ? `, effort ${context.effort}` : ''
	const parts = ids.flatMap((id) => {
		switch (id) {
			case 'hypermode':
				return context.steered ? [] : [`hypermode (this turn${effort})`]
			case 'save-skill':
				return [`save as skill (${context.steered ? 'after the running turn' : 'after this turn'})`]
			case 'schedule':
				return context.steered ? [] : ['schedule (the agent proposes a job)']
			case 'max-effort':
				return context.steered ? [] : [`max effort (this turn${effort})`]
		}
	})
	return parts.length > 0 ? parts.join(' · ') : undefined
}
