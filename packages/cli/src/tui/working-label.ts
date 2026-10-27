/**
 * What the working row says while a plan step is in progress: the step's
 * present-continuous form ("Running the tests") when the model gave one,
 * otherwise its subject, on one line and cut to fit beside the clock. With no
 * step in progress there is no label and the row keeps its default word.
 */

import type { ChecklistItem } from './Checklist.js'
import { clipText } from './truncation.js'

/** Room the clock, the token count and the margins take from the row. */
const RESERVED_COLUMNS = 40
const MIN_WIDTH = 12
const MAX_WIDTH = 60

export function workingLabel(tasks: readonly ChecklistItem[], columns: number): string | undefined {
	const step = tasks.find((task) => task.status === 'in_progress')
	if (!step) return undefined
	const text = [step.activeForm, step.subject]
		.map((candidate) => candidate?.replace(/\s+/gu, ' ').trim())
		.find((candidate) => candidate)
	if (!text) return undefined
	return clipText(text, Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, columns - RESERVED_COLUMNS)))
}
