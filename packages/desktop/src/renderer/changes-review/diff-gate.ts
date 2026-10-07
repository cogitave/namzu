/**
 * A rich diff builds tokens, rows and highlight work for every line, so one very large file can
 * freeze the review pane. Past these limits the pane shows the plain patch instead and offers the
 * rich view on request.
 */
export const RICH_DIFF_MAX_CHARACTERS = 180_000
export const RICH_DIFF_MAX_CHANGED_LINES = 1_200

export type RichDiffVerdict =
	| { rich: true }
	| { rich: false; reason: 'characters' | 'lines'; characters: number; changedLines: number }

/** Whether the rich view is safe for one file: the text on both sides and the lines that changed. */
export function richDiffVerdict(input: {
	before: string | null
	after: string | null
	added: number
	removed: number
}): RichDiffVerdict {
	const characters = (input.before?.length ?? 0) + (input.after?.length ?? 0)
	const changedLines = input.added + input.removed
	if (changedLines > RICH_DIFF_MAX_CHANGED_LINES) {
		return { rich: false, reason: 'lines', characters, changedLines }
	}
	if (characters > RICH_DIFF_MAX_CHARACTERS) {
		return { rich: false, reason: 'characters', characters, changedLines }
	}
	return { rich: true }
}

/** The sentence above a plain patch, naming what tripped the gate. */
export function gateNotice(verdict: Extract<RichDiffVerdict, { rich: false }>): string {
	const lines = verdict.changedLines.toLocaleString('en-US')
	return verdict.reason === 'lines'
		? `This diff changes ${lines} lines, so it is shown as a plain patch.`
		: `This diff is ${Math.round(verdict.characters / 1000).toLocaleString('en-US')}k characters, so it is shown as a plain patch.`
}
