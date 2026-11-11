import { parseDiffFromFile } from '@pierre/diffs'

/** How many rows the card shows before the person asks for the rest. */
export const PREVIEW_ROWS = 4

export interface PreviewRow {
	kind: 'context' | 'add' | 'remove'
	/** The line's number in the file it belongs to (the new file, except for a removed line). */
	line: number
	text: string
}

export interface ApprovalPreview {
	rows: PreviewRow[]
	/** Every row of the whole change, context included: what "Show all" opens. */
	total: number
}

const trimEol = (text: string | undefined) => (text ?? '').replace(/\r?\n$/, '')

/**
 * The first rows of a change, starting one line before the first thing that changed so the
 * reader sees where it sits. A change of any size is bounded to `limit` rows; `total` says how
 * many the whole change has.
 */
export function diffPreview(before: string, after: string, limit = PREVIEW_ROWS): ApprovalPreview {
	const meta = parseDiffFromFile({ name: 'a', contents: before }, { name: 'a', contents: after })
	const all: PreviewRow[] = []
	for (const hunk of meta.hunks) {
		for (const part of hunk.hunkContent) {
			if (part.type === 'context') {
				for (let i = 0; i < part.lines; i++)
					all.push({
						kind: 'context',
						line: part.additionLineIndex + i + 1,
						text: trimEol(meta.additionLines[part.additionLineIndex + i]),
					})
				continue
			}
			for (let i = 0; i < part.deletions; i++)
				all.push({
					kind: 'remove',
					line: part.deletionLineIndex + i + 1,
					text: trimEol(meta.deletionLines[part.deletionLineIndex + i]),
				})
			for (let i = 0; i < part.additions; i++)
				all.push({
					kind: 'add',
					line: part.additionLineIndex + i + 1,
					text: trimEol(meta.additionLines[part.additionLineIndex + i]),
				})
		}
	}
	const firstChange = all.findIndex((row) => row.kind !== 'context')
	const start = Math.max(0, firstChange - 1)
	return { rows: all.slice(start, start + limit), total: all.length }
}

/** The first lines of a command or any other text, with how many lines it has in all. */
export function textPreview(text: string, limit = PREVIEW_ROWS): ApprovalPreview {
	const lines = text.replace(/\r?\n$/, '').split(/\r?\n/)
	return {
		rows: lines
			.slice(0, limit)
			.map((line, index) => ({ kind: 'context', line: index + 1, text: line })),
		total: lines.length,
	}
}

/** A command cut to one line for the question: its first line, with an ellipsis when more follows. */
export function commandChip(command: string, max = 72): string {
	const first = command.trim().split(/\r?\n/)[0] ?? ''
	const cut = first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first
	return cut === command.trim() ? cut : cut.endsWith('…') ? cut : `${cut} …`
}
